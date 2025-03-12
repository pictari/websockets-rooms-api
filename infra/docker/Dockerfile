# two stage express js api build
FROM node:22-alpine AS build
WORKDIR /app

COPY app/package.json .
COPY app/package-lock.json .

RUN npm install

COPY app .

RUN npm run build

# production image
FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/package.json .
COPY --from=build /app/package-lock.json .

RUN npm install --only=production

ENV NODE_ENV=production

COPY --from=build /app/build .

CMD ["node", "index.js"]