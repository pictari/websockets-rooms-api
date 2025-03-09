import { verify as jwtVerify } from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

export function verifyJWT(token:string): any | undefined {
    const secret = process.env.JWTSECRET;
    if(secret == null) {
        console.log("Detected misconfigured JWT secret. No JWTs will be validated on this server!");
        return null;
    }

    try {
        const payload = jwtVerify(token, secret);
        return payload;
    } catch(error) {
        return null;
    }
}