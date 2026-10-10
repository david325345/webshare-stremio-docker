FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# Archiv hledání (anonymní) – v Coolify připoj na /app/data trvalý svazek
RUN mkdir -p /app/data/hledani
VOLUME ["/app/data"]

EXPOSE ${PORT:-7000}

CMD ["node", "server.js"]
