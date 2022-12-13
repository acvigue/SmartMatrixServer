const mqtt = require('mqtt')
const fs = require('fs');
const client  = mqtt.connect('**REDACTED**', {
    username: "**REDACTED**",
    password: "**REDACTED**"
})

let file = fs.readFileSync("/Users/aiden/pixlet/examples/bitcoin.webp");
let buf = new Uint8Array(file);

let bufPos = 0;
let chunkSize = 9950;
let hasSentLength = false;

client.on('connect', function () {
  client.subscribe('plm/20E7F8/applet/rts', function (err) {
    if (!err) {
      client.publish('plm/20E7F8/applet', "START");
    }
  })
})

client.on('message', function (topic, message) {
  if(topic = 'plm/20E7F8/applet/rts') {
    if(message == "OK") {
        if(bufPos <= buf.length) {
            if(hasSentLength == false) {
                hasSentLength = true;
                console.log("sending length", buf.length.toString());
                client.publish('plm/20E7F8/applet', buf.length.toString());
            } else {
                let chunk = buf.slice(bufPos, bufPos+chunkSize);
                console.log("sending chunk", bufPos, "to", bufPos+chunkSize);
                bufPos += chunkSize;
                client.publish('plm/20E7F8/applet', chunk);
            }
        } else {
            console.log("sending fin");
            client.publish('plm/20E7F8/applet', "FINISH");
        }
    } else {
        if(message == "PUSHED") {
            console.log("message successfully pushed to device...");
        } else if(message == "DECODE_ERROR") {
            console.log("message unsuccessfully pushed to device...");
        } else if(message == "DEVICE_BOOT") {
            console.log("device booted!");
        } else if(message == "TIMEOUT") {
            console.log("device rx timeout!");
        }
    }
  }
})