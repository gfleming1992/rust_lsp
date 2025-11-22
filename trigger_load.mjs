import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:5173');

ws.on('open', () => {
    console.log('Connected to dev server');
    ws.send(JSON.stringify({ command: 'Load', filePath: 'dummy' }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.command === 'tessellationData') {
        console.log('Received tessellation data');
        process.exit(0);
    }
});
