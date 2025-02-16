export class Gamedata {
    dynamoIdentifier?:string;
    name:string;
    ownerUuid:string;
    maxPlayers:number;
    isPrivate:boolean;
    joinKey?:string;
    gamemode:Gamemode;
    status:Status = Status.waiting;

    players:Set<string> = new Set;

    constructor(name: string, ownerUuid: string, maxPlayers: number, isPrivate: boolean, gamemode: Gamemode) {
        this.name = name;
        this.ownerUuid = ownerUuid;
        this.maxPlayers = maxPlayers;
        this.isPrivate = isPrivate;
        this.gamemode = gamemode;
    }
}

export enum Gamemode {
    brokenTelephone
}

export enum Status {
    waiting,
    ongoing
}