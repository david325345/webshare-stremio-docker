FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

USER node
EXPOSE ${PORT:-7000}

CMD ["node", "server.js"]
