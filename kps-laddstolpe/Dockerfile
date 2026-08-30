FROM node:20-alpine

# tzdata behovs for att Europe/Stockholm ska fungera i Alpine.
RUN apk add --no-cache tzdata

ENV NODE_ENV=production
WORKDIR /app

# Hela tillagget ar en enda fil. Inga npm-beroenden.
COPY app.js ./

CMD ["node", "/app/app.js"]
