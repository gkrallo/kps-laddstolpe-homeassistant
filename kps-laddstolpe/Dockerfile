FROM node:20-alpine

RUN apk add --no-cache tzdata

ENV NODE_ENV=production
WORKDIR /app

COPY app.js ./

CMD ["node", "/app/app.js"]
