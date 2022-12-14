const mqtt = require('mqtt')
const fs = require('fs');
const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler');
const { Watchdog } = require("watchdog");
const { exit } = require('process');

const client  = mqtt.connect('**REDACTED**', {
    username: "**REDACTED**",
    password: "**REDACTED**"
});

const scheduler = new ToadScheduler();
let chunkSize = 9950;

let config = {
    "20E7F8": {
        schedule: [
            {
                path: "test.webp",
                name: "bitcoin",
                duration: 10
            },
            {
                path: "maze.webp",
                name: "bitcoin2",
                duration: 10
            },
            {
                path: "fuzzyclock.webp",
                name: "bitcoin3",
                duration: 10
            }
        ],
        currentApplet: -1,
        currentAppletStartedAt: 0,
        connected: false,
        sendingStatus: {
            timed_out: false,
            retries: 0,
            currentBufferPos: 0,
            buf: null,
            hasSentLength: false,
            isCurrentlySending: false
        },
        jobRunning: false,
        offlineWatchdog: null
    }
};

function deviceLoop(device) {
    if(config[device].jobRunning || config[device].connected == false) {
        return;
    }

    config[device].jobRunning = true;
    client.publish(`plm/${device}/applet`, "PING");

    const nextAppletNeedsRunAt = config[device].currentAppletStartedAt + (config[device].schedule[config[device].currentApplet+1].duration * 1000);

    if(Date.now() > nextAppletNeedsRunAt && !config[device].sendingStatus.isCurrentlySending) {
        config[device].currentApplet++;

        const applet = config[device].schedule[config[device].currentApplet];
        config[device].sendingStatus.isCurrentlySending = true;
        
        let file = fs.readFileSync(applet.path);
        config[device].sendingStatus.buf = new Uint8Array(file);
        config[device].sendingStatus.currentBufferPos = 0;
        config[device].sendingStatus.hasSentLength = false;

        client.publish(`plm/${device}/rx`, "START");

        config[device].currentAppletStartedAt = Date.now();
        if(config[device].currentApplet >= (config[device].schedule.length - 1)) {
            config[device].currentApplet = -1;
        }
    }

    config[device].jobRunning = false;
}

function gotDeviceResponse(device, message) {
    config[device].offlineWatchdog.feed();
    if(message == "OK") {
        if(config[device].sendingStatus.currentBufferPos <= config[device].sendingStatus.buf.length) {
            if(config[device].sendingStatus.hasSentLength == false) {
                config[device].sendingStatus.hasSentLength = true;
                client.publish(`plm/${device}/rx`, config[device].sendingStatus.buf.length.toString());
            } else {
                let chunk = config[device].sendingStatus.buf.slice(config[device].sendingStatus.currentBufferPos, config[device].sendingStatus.currentBufferPos+chunkSize);
                config[device].sendingStatus.currentBufferPos += chunkSize;
                client.publish(`plm/${device}/rx`, chunk);
            }
        } else {
            client.publish(`plm/${device}/rx`, "FINISH");
        }
    } else {
        if(message == "PUSHED") {
            console.log("message successfully pushed to device...");
        } else if(message == "DECODE_ERROR") {
            console.log("message unsuccessfully pushed to device...");
        } else if(message == "DEVICE_BOOT" || message == "PONG") {
            console.log("device is online!");
        } else if(message == "TIMEOUT") {
            console.log("device rx timeout!");
        }
        config[device].connected = true;
        config[device].sendingStatus.isCurrentlySending = false;
        config[device].sendingStatus.hasSentLength = false;
        config[device].sendingStatus.currentBufferPos = 0;
        config[device].sendingStatus.buf = null;
    }
}

client.on('connect', function () {
    for(const [device, _] of Object.entries(config)) {
        client.subscribe(`plm/${device}/tx`, function (err) {
            if (!err) {
                client.publish(`plm/${device}/rx`, "PING");
                
                //Setup job to work on device.
                const task = new Task('simple task', () => {
                    deviceLoop(device)
                });
                
                const job = new SimpleIntervalJob(
                    { seconds: 5, runImmediately: true },
                    task,
                    { id: `loop_${device}` }
                );

                scheduler.addSimpleIntervalJob(job);

                const dog = new Watchdog(30000);
                dog.on('reset', () => {
                    console.log(`Device ${device} disconnected.`);
                    config[device].connected = false;
                    config[device].sendingStatus.isCurrentlySending = false;
                    config[device].sendingStatus.hasSentLength = false;
                    config[device].sendingStatus.currentBufferPos = 0;
                    config[device].sendingStatus.buf = null;
                })
                dog.on('feed',  () => {
                    config[device].connected = true;
                })

                config[device].offlineWatchdog = dog;
            } else {
                console.log(`Couldn't subscribe to ${device} response channel.`);
            }
        })
    }
});

client.on("disconnect", function() {
    scheduler.stop()
    exit(1);
});

client.on("error", function() {
    scheduler.stop()
    exit(1);
});

client.on("close", function() {
    scheduler.stop()
    exit(1);
});

client.on('message', function (topic, message) {
    if(topic.indexOf("tx") != -1) {
      const device = topic.split("/")[1];
      gotDeviceResponse(device, message);
    }
})