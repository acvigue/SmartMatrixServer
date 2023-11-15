FROM node:alpine

RUN apk upgrade --no-cache

COPY --from=golang:alpine /usr/local/go/ /usr/local/go/
ENV PATH="/usr/local/go/bin:${PATH}"

RUN apk add --no-cache git openssl libwebp libwebp-dev alpine-sdk tzdata && \
    git clone https://github.com/tidbyt/pixlet && \
    cd pixlet && \
    make build && \
    cp pixlet /bin/pixlet && \
    chmod +x /bin/pixlet && \
    cd / && rm -rf /pixlet /root/go /usr/local/go/ /root/.cache/go-build && \
    apk del alpine-sdk libwebp git

WORKDIR /app
COPY . .
RUN yarn 

ENV NODE_PATH=./build

RUN yarn build

USER 1000:1000

CMD [ "yarn", "start" ]
