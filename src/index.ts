import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 } from 'uuid';

const pathServer: Map<string, WebSocketServer> = new Map();

// https://medium.com/@libinthomas33/building-a-crud-api-server-in-node-js-using-http-module-9fac57e2f47d
const server = createServer((req, res) =>
{
    if(req.method === 'UPGRADE') {
        return;
    }

    // do additional stuff when we bring in authentication and admins
    /*
    let body = "";
    let resultingJson : JSON;

    req.on("data", (chunk) => {
        body += chunk;
    })

    req.on("end", () => {
        resultingJson = JSON.parse(body);
    }) */

    if(req.method === 'POST') {
        let newPath = raiseNewWSServer();
        res.writeHead(201, { "content-type": "application/json" });
        res.end({"newServerPath": newPath});
    }
});

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

server.listen(8080);


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
    return name;
}