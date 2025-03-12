# two stage express js api build
FROM node:22-alpine AS build

WORKDIR /app

COPY app/package.json .
COPY app/package-lock.json .

RUN npm install

COPY app .

RUN npm run build

CMD ["node", "build/index.js"]