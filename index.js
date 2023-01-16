const mqtt = require('mqtt')
const fs = require('fs');
const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler');
const { Watchdog } = require("watchdog");
const { exit } = require('process');
const {spawn} = require("child_process");

const client  = mqtt.connect('**REDACTED**', {
    username: "**REDACTED**",
    password: "**REDACTED**"
});

const scheduler = new ToadScheduler();
let chunkSize = 39999;

let config = {
    "20E7F8": {
        schedule: [
            {
                name: "paraland",
                duration: 10,
                config: {
                    image: "north_carolina_morning"
                }
            },
            {
                name: "spotify",
                config: {
                    refresh_token: "**REDACTED**",
                    client_id: "**REDACTED**",
                    client_secret: "**REDACTED**"
                },
                duration: 10
            },
            {
                name: "paraland",
                duration: 10,
                config: {
                    image: "seattle_morning"
                }
            },
            {
                name: "oura_ring",
                config: {
                    apikey: "**REDACTED**",
                    days: "14"
                },
                duration: 10
            },
            {
                name: "unsplash",
                duration: 10
            },
            {
                name: "weather",
                duration: 10,
                config: {
                    location: {
                        lat: 37.206629,
                        lng: -79.979439,
                        timezone: "America/New_York"
                    },
                    jwt: "**REDACTED**"
                }
            },
            {
                name: "paraland",
                duration: 10,
                config: {
                    image: "arizona_day"
                }
            },
            {
                name: "datadogmonitors",
                duration: 5,
                config: {
                    api_key: "**REDACTED**",
                    app_key: "**REDACTED**"
                }
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

async function devicePing(device) {
    client.publish(`plm/${device}/applet`, "PING");
}

async function deviceLoop(device) {
    if(config[device].jobRunning || config[device].connected == false) {
        return;
    }

    config[device].jobRunning = true;

    const nextAppletNeedsRunAt = config[device].currentAppletStartedAt + (config[device].schedule[config[device].currentApplet+1].duration * 1000);

    if(Date.now() > nextAppletNeedsRunAt && !config[device].sendingStatus.isCurrentlySending) {
        config[device].currentApplet++;

        const applet = config[device].schedule[config[device].currentApplet];
        config[device].sendingStatus.isCurrentlySending = true;

        let imageData = await render(applet.name, applet.config ?? {}).catch((e) => {
            //upon failure, skip applet and retry.
            console.log(e);
            config[device].currentApplet++;
            config[device].sendingStatus.isCurrentlySending = false;
            if(config[device].currentApplet >= (config[device].schedule.length - 1)) {
                config[device].currentApplet = -1;
            }
            setTimeout(() => {
                deviceLoop(device);
            }, 5);
        })

        if(config[device].sendingStatus.isCurrentlySending) {
            config[device].sendingStatus.buf = new Uint8Array(imageData);
            config[device].sendingStatus.currentBufferPos = 0;
            config[device].sendingStatus.hasSentLength = false;

            client.publish(`plm/${device}/rx`, "START");

            if(config[device].currentApplet >= (config[device].schedule.length - 1)) {
                config[device].currentApplet = -1;
            }
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
        if(message == "DECODE_ERROR" || message == "PUSHED") {
            config[device].currentAppletStartedAt = Date.now();
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

function render(name, config) {
    return new Promise(async (resolve, reject) => {
        let configValues = [];
        for(const [k, v] of Object.entries(config)) {
            if(typeof v === 'object') {
                configValues.push(`${k}=${JSON.stringify(v)}`);
            } else {
                configValues.push(`${k}=${v}`);
            }
        }
        let outputError = "";
        let unedited = fs.readFileSync(`applets/${name}/${name}.star`).toString()
        if(unedited.indexOf(`load("cache.star", "cache")`) != -1) {
            const redis_connect_string = `cache_redis.connect("**REDACTED**", "default", "**REDACTED**")`
            unedited = unedited.replaceAll(`load("cache.star", "cache")`, `load("cache_redis.star", "cache_redis")\n${redis_connect_string}`);
            unedited = unedited.replaceAll(`cache.`, `cache_redis.`);
        }
        fs.writeFileSync(`applets/${name}/${name}.tmp.star`, unedited)

        const renderCommand = spawn('./pixlet', ['render', `applets/${name}/${name}.tmp.star`,...configValues,'-o',`applets/${name}/${name}.webp`]);
    
        var timeout = setTimeout(() => {
            console.log(`Rendering timed out for ${name}`);
            try {
              process.kill(renderCommand.pid, 'SIGKILL');
            } catch (e) {
              console.log('Could not kill process ^', e);
            }
        }, 10000);

        renderCommand.stdout.on('data', (data) => {
            outputError += data
        })

        renderCommand.stderr.on('data', (data) => {
            outputError += data
        })
    
        renderCommand.on('close', (code) => {
            clearTimeout(timeout);
            if(code == 0) {
                if(outputError.indexOf("skip_execution") == -1) {
                    resolve(fs.readFileSync(`applets/${name}/${name}.webp`));
                } else {
                    reject("Applet requested to skip execution...");
                }
            } else {
                console.error(outputError);
                reject("Applet failed to render.");
            }
        });
    })
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
                    { seconds: 1, runImmediately: true },
                    task,
                    { id: `loop_${device}` }
                );

                //Setup job to ping device.
                const ping_task = new Task('ping task', () => {
                    devicePing(device)
                });
                
                const ping_job = new SimpleIntervalJob(
                    { seconds: 10, runImmediately: true },
                    ping_task,
                    { id: `ping_${device}` }
                );

                scheduler.addSimpleIntervalJob(job);
                scheduler.addSimpleIntervalJob(ping_job);

                const dog = new Watchdog(60000);
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