import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 } from 'uuid';

const pathServer: Map<string, WebSocketServer> = new Map();

const server = createServer();

server.on('upgrade', function upgrade(request, socket, head) {
    // change base url when we get a domain
    let pathName = new URL(request.url as string, 'ws://pictari.app');
    let found : boolean = false;

    // cycle through all the active "sub"servers
    for(let key in pathServer.keys) {
        if(pathName.toString() === '/' + key) {
            found = true;
            let wss = pathServer.get(key);
            wss?.handleUpgrade(request, socket, head, function done(ws) {
                wss.emit('connection', ws, request);
            })
            break;
        }
    }

    if(!found) {
        socket.destroy();
    }
})

function raiseNewWSServer() {
    // is it excessive to use UUIDs for server names
    // (yes)
    // fun fact: this is the same UUID type that minecraft uses
    let name = v4();

    let wss = new WebSocketServer({noServer: true});

    // set up behavior
    wss.on('connection', function connection(ws) {
        ws.on('error', console.error);

        ws.on('message', function message(data) {
            let json = JSON.parse(data.toString());
        })
    })

    pathServer.set(name, wss);
}

server.listen(8080);