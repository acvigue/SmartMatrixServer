FROM node:current-alpine

RUN apk add --no-cache git openssl go libwebp libwebp-dev alpine-sdk tzdata && \
    git clone https://github.com/tidbyt/pixlet && \
    cd pixlet && \
    make build && \
    cp pixlet /bin/pixlet && \
    chmod +x /bin/pixlet && \
    cd / && rm -rf /pixlet /root/go /root/.cache/go-build && \
    apk del alpine-sdk go libwebp git

WORKDIR /app
COPY . .
RUN npm install
USER 1000:1000

CMD [ "node", "index.js" ]
