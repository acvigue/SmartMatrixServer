FROM node:current-alpine

RUN apk add --no-cache git openssl go libwebp libwebp-dev alpine-sdk tzdata
RUN git clone https://github.com/acvigue/pixlet
RUN cd pixlet && make build
RUN cd /pixlet && cp pixlet /bin/pixlet && chmod +x /bin/pixlet
RUN cd / && rm -rf /pixlet /root/go /root/.cache/go-build
RUN apk del alpine-sdk go libwebp git

WORKDIR /app
COPY . .
RUN npm install
USER 1000:1000

CMD [ "node", "index.js" ]
