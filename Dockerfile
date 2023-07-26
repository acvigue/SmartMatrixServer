FROM node:alpine

RUN apk add --no-cache git openssl go libwebp libwebp-dev alpine-sdk tzdata && \
    git clone https://github.com/tidbyt/pixlet && \
    cd pixlet && \
    make build && \
    cp pixlet /bin/pixlet && \
    chmod +x /bin/pixlet && \
    cd / && rm -rf /pixlet /root/go /root/.cache/go-build && \
    apk del alpine-sdk go libwebp git

RUN npm install -g yarn

WORKDIR /app
COPY . .
RUN yarn 

ENV NODE_PATH=./build

RUN yarn build

USER 1000:1000

CMD [ "yarn", "start" ]
