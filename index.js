const mqtt = require('mqtt')
const fs = require('fs');
const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler');
const { Watchdog } = require("watchdog");
const { exit } = require('process');
const {spawn} = require("child_process");
const { Readable } = require("stream");
const YAML = require("yaml");

/*

Required environment variables for applet-sender to function
MQTT_[HOSTNAME,USERNAME,PASSWORD]
REDIS_[HOSTNAME,USERNAME,PASSWORD],
[CONFIG,APPLET]_FOLDER

*/

const client  = mqtt.connect(process.env.MQTT_HOSTNAME, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD
});

let { CONFIG_FOLDER } = process.env
if(CONFIG_FOLDER === undefined) {
    console.log("CONFIG_FOLDER not set, using `/config` ...");
    CONFIG_FOLDER = "/config";
}

let { APPLET_FOLDER } = process.env
if(APPLET_FOLDER === undefined) {
    console.log("APPLET_FOLDER not set, using `/applets` ...");
    APPLET_FOLDER = "/applets";
}

const scheduler = new ToadScheduler();
let chunkSize = 19950;

let config = {};

const directory = fs.opendirSync(CONFIG_FOLDER)
let file;

while ((file = directory.readSync()) !== null) {
    let device = file.name.split(".")[0];
    if(device.indexOf("/") != -1) {
        device = device.split("/")[1];
    }

    let scheduleFilePath = `${CONFIG_FOLDER}/${device.toUpperCase()}.json`;
    if(!fs.existsSync(scheduleFilePath)) {
        console.log("Schedule file for device does not exist!");
        return;
    }

    let schedule = fs.readFileSync(scheduleFilePath);

    config[device] = {
        currentApplet: -1,
        currentAppletStartedAt: 0,
        connected: false,
        sendingStatus: {
            bufPos: 0,
            buf: null,
            hasSentLength: false,
            isCurrentlySending: false
        },
        jobRunning: false,
        offlineWatchdog: null,
        schedule: JSON.parse(schedule)
    }
}

directory.closeSync()

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
            config[device].sendingStatus.bufPos = 0;
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
        if(config[device].sendingStatus.bufPos <= config[device].sendingStatus.buf.length) {
            if(config[device].sendingStatus.hasSentLength == false) {
                config[device].sendingStatus.hasSentLength = true;
                client.publish(`plm/${device}/rx`, config[device].sendingStatus.buf.length.toString());
            } else {
                let chunk = config[device].sendingStatus.buf.slice(config[device].sendingStatus.bufPos, config[device].sendingStatus.bufPos+chunkSize);
                config[device].sendingStatus.bufPos += chunkSize;
                client.publish(`plm/${device}/rx`, chunk);
            }
        } else {
            client.publish(`plm/${device}/rx`, "FINISH");
        }
    } else {
        if(message == "DECODE_ERROR" || message == "PUSHED") {
            config[device].currentAppletStartedAt = Date.now();
            config[device].sendingStatus.isCurrentlySending = false;
            config[device].sendingStatus.hasSentLength = false;
            config[device].sendingStatus.bufPos = 0;
            config[device].sendingStatus.buf = null;
        } else if(message == "DEVICE_BOOT") {
            console.log("device is online!");
            config[device].sendingStatus.isCurrentlySending = false;
            config[device].sendingStatus.hasSentLength = false;
            config[device].sendingStatus.bufPos = 0;
            config[device].sendingStatus.buf = null;
        } else if(message == "TIMEOUT") {
            console.log("device rx timeout!");
            config[device].sendingStatus.isCurrentlySending = false;
            config[device].sendingStatus.hasSentLength = false;
            config[device].sendingStatus.bufPos = 0;
            config[device].sendingStatus.buf = null;
        }
        config[device].connected = true;
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
        let manifest = YAML.parse(fs.readFileSync(`${APPLET_FOLDER}/${name}/manifest.yaml`, 'utf-8'));
        let appletContents = fs.readFileSync(`${APPLET_FOLDER}/${name}/${manifest.fileName}`).toString();
        if(process.env.REDIS_HOSTNAME != undefined) {
            if(appletContents.indexOf(`load("cache.star", "cache")`) != -1) {
                const redis_connect_string = `cache_redis.connect("${ process.env.REDIS_HOSTNAME }", "${ process.env.REDIS_USERNAME }", "${ process.env.REDIS_PASSWORD }")`
                appletContents = appletContents.replaceAll(`load("cache.star", "cache")`, `load("cache_redis.star", "cache_redis")\n${redis_connect_string}`);
                appletContents = appletContents.replaceAll(`cache.`, `cache_redis.`);
            }
        }
        fs.writeFileSync(`${APPLET_FOLDER}/${name}/${manifest.fileName.replace(".star",".tmp.star")}`, appletContents);

        const renderCommand = spawn(`pixlet`, ['render', `${APPLET_FOLDER}/${name}/${manifest.fileName.replace(".star",".tmp.star")}`,...configValues,'-o',`${APPLET_FOLDER}/${name}/${manifest.fileName}.webp`]);
    
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
                    resolve(fs.readFileSync(`${APPLET_FOLDER}/${name}/${manifest.fileName}.webp`));
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

                const pingTask = new Task('simple ping task', () => {
                    client.publish(`plm/${device}/rx`, "PING");
                });
                
                const job = new SimpleIntervalJob(
                    { seconds: 1, runImmediately: true },
                    task,
                    { id: `loop_${device}` }
                );

                const pingJob = new SimpleIntervalJob(
                    { seconds: 30, runImmediately: true },
                    pingTask,
                    { id: `ping_${device}` }
                );

                scheduler.addSimpleIntervalJob(job);
                scheduler.addSimpleIntervalJob(pingJob);

                const dog = new Watchdog(60000);
                dog.on('reset', () => {
                    console.log(`Device ${device} disconnected.`);
                    config[device].connected = false;
                    config[device].sendingStatus.isCurrentlySending = false;
                    config[device].sendingStatus.hasSentLength = false;
                    config[device].sendingStatus.bufPos = 0;
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
    client.reconnect();
});

client.on("error", function() {
    scheduler.stop();
    client.reconnect();
});

client.on("close", function() {
    scheduler.stop()
});

client.on('message', function (topic, message) {
    if(topic.indexOf("tx") != -1) {
      const device = topic.split("/")[1];
      gotDeviceResponse(device, message);
    }
})

process.once('SIGTERM', function (code) {
    console.log('SIGTERM received...');
    client.end(false);
});