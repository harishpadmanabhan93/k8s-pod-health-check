// Node 22.x has fetch built-in, no need for node-fetch
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const sgMail = require('@sendgrid/mail');

const HISTORY_FILE = 'pod_health_history.json';
const REPORT_FILE = 'problematic_pods_report.json';

function isPodProblematic(pod) {
    const errorReasons = [
        'CrashLoopBackOff',
        'ImagePullBackOff',
        'ErrImagePull',
        'CreateContainerConfigError',
        'RunContainerError',
        'Error',
        'ContainerCannotRun',
        'OOMKilled',
        'Evicted',
        'DeadlineExceeded',
    ];
    if (pod.status.phase !== 'Running') return true;
    if (Array.isArray(pod.status.containerStatuses)) {
        return pod.status.containerStatuses.some(cs => {
            const waitingReason = cs.state?.waiting?.reason || '';
            const lastTerminatedReason = cs.lastState?.terminated?.reason || '';
            const restartCount = cs.restartCount || 0;
            return errorReasons.includes(waitingReason) || errorReasons.includes(lastTerminatedReason) || restartCount > 3;
        });
    }
    return false;
}

function categorizeSeverity(pod) {
    // Critical: CrashLoopBackOff, OOMKilled, ImagePullBackOff, >5 restarts
    // Warning: >3 restarts, Completed, Evicted, DeadlineExceeded
    // Info: Other non-running phases
    const errorReasonsCritical = ['CrashLoopBackOff', 'OOMKilled', 'ImagePullBackOff', 'ContainerCannotRun'];
    const errorReasonsWarning = ['Completed', 'Evicted', 'DeadlineExceeded', 'ErrImagePull', 'Error'];
    let severity = 'Info';
    let reasons = [];
    if (Array.isArray(pod.status.containerStatuses)) {
        for (const cs of pod.status.containerStatuses) {
            const waitingReason = cs.state?.waiting?.reason || '';
            const lastTerminatedReason = cs.lastState?.terminated?.reason || '';
            const restartCount = cs.restartCount || 0;
            if (errorReasonsCritical.includes(waitingReason) || errorReasonsCritical.includes(lastTerminatedReason) || restartCount > 5) {
                severity = 'Critical';
                reasons.push(waitingReason, lastTerminatedReason);
            } else if (errorReasonsWarning.includes(waitingReason) || errorReasonsWarning.includes(lastTerminatedReason) || restartCount > 3) {
                if (severity !== 'Critical') severity = 'Warning';
                reasons.push(waitingReason, lastTerminatedReason);
            }
        }
    }
    if (pod.status.phase !== 'Running' && severity === 'Info') {
        severity = 'Info';
        reasons.push(pod.status.phase);
    }
    return { severity, reasons: reasons.filter(Boolean) };
}

async function sendEmail(subject, text) {
    const EMAIL_TO = process.env.EMAIL_TO;
    const EMAIL_FROM = process.env.EMAIL_FROM;
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
    if (!EMAIL_TO || !EMAIL_FROM || !SENDGRID_API_KEY) {
        console.error('Missing EMAIL_TO, EMAIL_FROM, or SENDGRID_API_KEY environment variables');
        return;
    }
    sgMail.setApiKey(SENDGRID_API_KEY);
    const msg = {
        to: EMAIL_TO,
        from: EMAIL_FROM,
        subject,
        text,
    };
    try {
        await sgMail.send(msg);
        console.log('Email sent successfully');
    } catch (e) {
        console.error('Failed to send email:', e.message);
    }
}

function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch (e) {
            return [];
        }
    }
    return [];
}

function saveHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function analyzeTrends(history, currentPods) {
    // Returns: { recurring: [], newIssues: [], resolved: [] }
    const lastRun = history.length > 0 ? history[history.length - 1].problematicPods : [];
    const lastPodNames = new Set(lastRun.map(p => p.name + ':' + p.namespace));
    const currentPodNames = new Set(currentPods.map(p => p.name + ':' + p.namespace));
    const recurring = currentPods.filter(p => lastPodNames.has(p.name + ':' + p.namespace));
    const newIssues = currentPods.filter(p => !lastPodNames.has(p.name + ':' + p.namespace));
    const resolved = lastRun.filter(p => !currentPodNames.has(p.name + ':' + p.namespace));
    return { recurring, newIssues, resolved };
}

function groupPodsByIssueType(pods) {
    // Group pods by their main issue reason
    const groups = {};
    for (const pod of pods) {
        // Use the first reason as the main issue type
        const mainReason = pod.reasons && pod.reasons.length > 0 ? pod.reasons[0] : pod.reason || 'Unknown';
        if (!groups[mainReason]) groups[mainReason] = [];
        groups[mainReason].push(pod);
    }
    return groups;
}

async function getOpenAISummaryAndConfidence(pod, events, logs, OPENAI_API_KEY) {
    const prompt = `Pod Name: ${pod.name}\nNamespace: ${pod.namespace}\nPhase: ${pod.phase}\nReason: ${pod.reason}\nMessage: ${pod.message}\nEvents: ${JSON.stringify(events)}\nLogs: ${logs}\n\nSummarize the reason for this pod not running or being unhealthy (including CrashLoopBackOff, ImagePullBackOff, etc), suggest possible fixes, and estimate a confidence score (0-100%) for your fix suggestion. Respond in JSON: {summary: string, suggestion: string, confidence: number}`;
    try {
        const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 400,
            }),
        });
        if (openaiResp.ok) {
            const openaiData = await openaiResp.json();
            let content = openaiData.choices[0].message.content;
            // Try to parse JSON
            try {
                if (content.startsWith('```json')) content = content.replace(/```json|```/g, '').trim();
                return JSON.parse(content);
            } catch (e) {
                // fallback: return as summary only
                return { summary: content, suggestion: '', confidence: 50 };
            }
        }
    } catch (e) {
        return { summary: 'Failed to get summary from OpenAI.', suggestion: '', confidence: 0 };
    }
    return { summary: 'No response from OpenAI.', suggestion: '', confidence: 0 };
}

async function main() {
    const KUBE_API_SERVER = process.env.KUBE_API_SERVER;
    const KUBE_TOKEN = process.env.KUBE_TOKEN;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!KUBE_API_SERVER || !KUBE_TOKEN || !OPENAI_API_KEY) {
        console.error('Missing required environment variables: KUBE_API_SERVER, KUBE_TOKEN, OPENAI_API_KEY');
        process.exit(1);
    }

    try {
        console.log('Fetching all pods in all namespaces...');
        const podsResp = await fetch(`${KUBE_API_SERVER}/api/v1/pods`, {
            headers: {
                'Authorization': `Bearer ${KUBE_TOKEN}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            method: 'GET',
        });
        if (!podsResp.ok) throw new Error(`Failed to fetch pods: ${podsResp.statusText}`);
        const podsData = await podsResp.json();
        const pods = podsData.items || [];
        fs.writeFileSync('all_pods_debug.json', JSON.stringify(pods, null, 2));
        console.log(`Total pods fetched: ${pods.length}`);
        const problematicPodsRaw = pods.filter(isPodProblematic);
        // Map to {name, namespace, phase, reason, message, severity, reasons}
        const problematicPods = problematicPodsRaw.map(pod => {
            const { severity, reasons } = categorizeSeverity(pod);
            return {
                name: pod.metadata.name,
                namespace: pod.metadata.namespace,
                phase: pod.status.phase,
                reason: pod.status.reason || '',
                message: pod.status.message || '',
                severity,
                reasons,
            };
        });
        // Historical trend analysis
        const history = loadHistory();
        const trends = analyzeTrends(history, problematicPods);
        // Save current run to history
        history.push({ timestamp: new Date().toISOString(), problematicPods });
        saveHistory(history);
        let emailBody = '';
        if (problematicPods.length === 0) {
            emailBody = 'All pods are healthy (no CrashLoopBackOff, ImagePullBackOff, etc).';
            await sendEmail('Kubernetes Pod Health Report', emailBody);
            return;
        }
        emailBody += `Found ${problematicPods.length} problematic pods.\n\n`;
        // Group issues by type for recurring, new, resolved
        const groupedRecurring = groupPodsByIssueType(trends.recurring);
        const groupedNew = groupPodsByIssueType(trends.newIssues);
        const groupedResolved = groupPodsByIssueType(trends.resolved);
        if (trends.recurring.length > 0) {
            emailBody += `Recurring Issues (${trends.recurring.length}):\n`;
            for (const [issueType, pods] of Object.entries(groupedRecurring)) {
                emailBody += `- ${issueType}:\n`;
                for (const pod of pods) {
                    emailBody += `    - ${pod.name} (Namespace: ${pod.namespace})\n`;
                }
            }
            emailBody += '\n';
        }
        if (trends.newIssues.length > 0) {
            emailBody += `New Issues (${trends.newIssues.length}):\n`;
            for (const [issueType, pods] of Object.entries(groupedNew)) {
                emailBody += `- ${issueType}:\n`;
                for (const pod of pods) {
                    emailBody += `    - ${pod.name} (Namespace: ${pod.namespace})\n`;
                }
            }
            emailBody += '\n';
        }
        if (trends.resolved.length > 0) {
            emailBody += `Resolved Issues (${trends.resolved.length}):\n`;
            for (const [issueType, pods] of Object.entries(groupedResolved)) {
                emailBody += `- ${issueType}:\n`;
                for (const pod of pods) {
                    emailBody += `    - ${pod.name} (Namespace: ${pod.namespace})\n`;
                }
            }
            emailBody += '\n';
        }
        // Sort by severity: Critical > Warning > Info
        problematicPods.sort((a, b) => {
            const sevOrder = { 'Critical': 0, 'Warning': 1, 'Info': 2 };
            return sevOrder[a.severity] - sevOrder[b.severity];
        });
        const results = [];
        // Group all problematic pods by issue type for the report
        const groupedAll = groupPodsByIssueType(problematicPods);
        for (const [issueType, pods] of Object.entries(groupedAll)) {
            emailBody += `\n=== Issue Type: ${issueType} (${pods.length} pods) ===\n`;
            for (const pod of pods) {
                let events = [];
                let logs = '';
                try {
                    const eventsResp = await fetch(`${KUBE_API_SERVER}/api/v1/namespaces/${pod.namespace}/events?fieldSelector=involvedObject.name=${pod.name}`, {
                        headers: {
                            'Authorization': `Bearer ${KUBE_TOKEN}`,
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                        },
                        method: 'GET',
                    });
                    if (eventsResp.ok) {
                        const eventsData = await eventsResp.json();
                        events = eventsData.items || [];
                    }
                } catch (e) {
                    console.error(`Failed to fetch events for pod ${pod.name}:`, e.message);
                }
                try {
                    const logsResp = await fetch(`${KUBE_API_SERVER}/api/v1/namespaces/${pod.namespace}/pods/${pod.name}/log`, {
                        headers: {
                            'Authorization': `Bearer ${KUBE_TOKEN}`,
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                        },
                        method: 'GET',
                    });
                    if (logsResp.ok) {
                        logs = await logsResp.text();
                    }
                } catch (e) {
                    console.error(`Failed to fetch logs for pod ${pod.name}:`, e.message);
                }
                // OpenAI summary and confidence
                let aiResult = await getOpenAISummaryAndConfidence(pod, events, logs, OPENAI_API_KEY);
                results.push({
                    ...pod,
                    events,
                    logs,
                    summary: aiResult.summary,
                    suggestion: aiResult.suggestion,
                    confidence: aiResult.confidence
                });
                emailBody += `[${pod.severity}] Pod: ${pod.name} (Namespace: ${pod.namespace})\nStatus: ${pod.phase}\nReason: ${pod.reason}\nMessage: ${pod.message}\nSummary: ${aiResult.summary}\nSuggestion: ${aiResult.suggestion}\nConfidence: ${aiResult.confidence}%\n---\n`;
            }
        }
        fs.writeFileSync(REPORT_FILE, JSON.stringify(results, null, 2));
        console.log(`Report written to ${REPORT_FILE}`);
        await sendEmail('Kubernetes Pod Health Report', emailBody);
    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }
}

main();

