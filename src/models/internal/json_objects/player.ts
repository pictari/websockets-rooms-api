export class Player {
    uuid:string;
    readyStatus:ReadyStatus;

    constructor(uuid:string, readyStatus:ReadyStatus) {
        this.uuid = uuid;
        this.readyStatus = readyStatus;
    }
}

export enum ReadyStatus {
    pending,
    ready
}