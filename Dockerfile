FROM node:current-alpine
RUN apk add openssl
WORKDIR /app
COPY . .
RUN npm install
USER 1000:1000
CMD [ "node", "index.js" ]