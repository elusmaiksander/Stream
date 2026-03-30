FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js proxy.js ./

EXPOSE 3000 3001

CMD ["sh", "-c", "node proxy.js & PROXY_URL=http://localhost:3001 node index.js"]
