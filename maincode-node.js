// Node 22.x has fetch built-in, no need for node-fetch
// Add this line to ignore self-signed SSL certificate errors (for local dev/minikube)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
        const problematicPods = pods.filter(pod => pod.status.phase !== 'Running');
        if (problematicPods.length === 0) {
            console.log('All pods are running.');
            return;
        }
        console.log(`Found ${problematicPods.length} problematic pods.`);
        const results = [];
        for (const pod of problematicPods) {
            const namespace = pod.metadata.namespace;
            const name = pod.metadata.name;
            const phase = pod.status.phase;
            const reason = pod.status.reason || '';
            const message = pod.status.message || '';
            let events = [];
            let logs = '';
            // Get events
            try {
                const eventsResp = await fetch(`${KUBE_API_SERVER}/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name=${name}`, {
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
                console.error(`Failed to fetch events for pod ${name}:`, e.message);
            }
            // Get logs (only for pods that have started at least once)
            try {
                const logsResp = await fetch(`${KUBE_API_SERVER}/api/v1/namespaces/${namespace}/pods/${name}/log`, {
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
                console.error(`Failed to fetch logs for pod ${name}:`, e.message);
            }
            // Use OpenAI to summarize and suggest fix
            let summary = '';
            try {
                const prompt = `Pod Name: ${name}\nNamespace: ${namespace}\nPhase: ${phase}\nReason: ${reason}\nMessage: ${message}\nEvents: ${JSON.stringify(events)}\nLogs: ${logs}\n\nSummarize the reason for this pod not running and suggest possible fixes.`;
                const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OPENAI_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: 'gpt-3.5-turbo',
                        messages: [{ role: 'user', content: prompt }],
                        max_tokens: 300,
                    }),
                });
                if (openaiResp.ok) {
                    const openaiData = await openaiResp.json();
                    summary = openaiData.choices[0].message.content;
                }
            } catch (e) {
                summary = 'Failed to get summary from OpenAI.';
            }
            results.push({
                name,
                namespace,
                phase,
                reason,
                message,
                events,
                logs,
                summary,
            });
            console.log(`Pod: ${name} (Namespace: ${namespace})\nStatus: ${phase}\nReason: ${reason}\nMessage: ${message}\nSummary: ${summary}\n---`);
        }
        // Optionally, write results to a file
        const fs = require('fs');
        fs.writeFileSync('problematic_pods_report.json', JSON.stringify(results, null, 2));
        console.log('Report written to problematic_pods_report.json');
    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }
}

main();

