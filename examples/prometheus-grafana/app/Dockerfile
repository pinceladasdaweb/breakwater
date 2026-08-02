FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
