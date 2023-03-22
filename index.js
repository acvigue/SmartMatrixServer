const mqtt = require('mqtt')
const fs = require('fs');
const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler');
const { Watchdog } = require("watchdog");
const { spawn } = require("child_process");
const YAML = require("yaml");
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
var crypto = require('crypto');

/*

Required environment variables for applet-sender to function
MQTT_[HOSTNAME,USERNAME,PASSWORD]
REDIS_[HOSTNAME,USERNAME,PASSWORD],
[CONFIG,APPLET]_FOLDER

*/

const client = mqtt.connect(process.env.MQTT_HOSTNAME, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD
});

let { CONFIG_FOLDER } = process.env
if (CONFIG_FOLDER === undefined) {
    console.log("CONFIG_FOLDER not set, using `/config` ...");
    CONFIG_FOLDER = "/config";
}

let { APPLET_FOLDER } = process.env
if (APPLET_FOLDER === undefined) {
    console.log("APPLET_FOLDER not set, using `/applets` ...");
    APPLET_FOLDER = "/applets";
}

const scheduler = new ToadScheduler();
let chunkSize = 19950;

let config = {};
let hashes = {};

const directory = fs.opendirSync(CONFIG_FOLDER)
let file;

while ((file = directory.readSync()) !== null) {
    let device = file.name.split(".")[0];
    if (device.indexOf("/") != -1) {
        device = device.split("/")[1];
    }

    let scheduleFilePath = `${CONFIG_FOLDER}/${device.toUpperCase()}.json`;
    if (!fs.existsSync(scheduleFilePath)) {
        console.log("Schedule file for device does not exist!");
        return;
    }

    let schedule = fs.readFileSync(scheduleFilePath);
    let reducedSchedule = [];
    schedule = JSON.parse(schedule);
    schedule.forEach((v, i) => {
        schedule[i]["uuid"] = i.toString();

        reducedSchedule.push({
            d: schedule[i].duration,
            s: false,
            p: false
        })
    })



    config[device] = {
        currentApplet: -1,
        currentlyUpdatingApplet: -1,
        connected: false,
        sendingStatus: {
            bufPos: 0,
            buf: null,
            isCurrentlySending: false,
            currentHash: {
                key: "",
                hash: ""
            }
        },
        offlineWatchdog: null,
        dataTimeout: null,
        schedule: schedule,
        reducedSchedule: reducedSchedule,
        reducedScheduleSHA: "",
        deviceReducedSchedule: [],
        deviceReducedScheduleSHA: null,
    }
}

directory.closeSync()

function publishToDevice(device, obj) {
    let serializedAsBuffer = JSON.stringify(obj);
    client.publish(`smartmatrix/${device}/command`, serializedAsBuffer);
}

async function appletUpdateLoop(device) {
    if (config[device].sendingStatus.isCurrentlySending || config[device].connected == false) {
        return;
    }

    config[device].sendingStatus.isCurrentlySending = true;
    config[device].currentlyUpdatingApplet++;
    
    if (config[device].currentlyUpdatingApplet >= config[device].schedule.length) {
        config[device].currentlyUpdatingApplet = 0;
    }

    const applet = config[device].schedule[config[device].currentlyUpdatingApplet];
    const appletExternal = applet.external ?? false;
    let imageData = null;
    if (appletExternal) {
        let configValues = [];
        for (const [k, v] of Object.entries(applet.config)) {
            if (typeof v === 'object') {
                configValues.push(`${k}=${encodeURIComponent(JSON.stringify(v))}`);
            } else {
                configValues.push(`${k}=${encodeURIComponent(v)}`);
            }
        }
        let confStr = configValues.join("&");
        let url = `https://prod.tidbyt.com/app-server/preview/${applet.name}.webp?${confStr}`;

        try {
            imageData = await axios.get(url, {
                responseType: 'arraybuffer'
            });
            imageData = imageData.data;
        } catch(e) {
            config[device].reducedSchedule[config[device].currentlyUpdatingApplet].s = true;
            config[device].sendingStatus.isCurrentlySending = false;
        }
    } else {
        imageData = await render(device, applet.name, applet.config ?? {}).catch((e) => {
            config[device].reducedSchedule[config[device].currentlyUpdatingApplet].s = true;
            config[device].sendingStatus.isCurrentlySending = false;
        })
    }

    if (config[device].sendingStatus.isCurrentlySending) {
        config[device].reducedSchedule[config[device].currentlyUpdatingApplet].s = false;

        //Check if applet needs to be pushed to device before sending
        const hashKey = `${device}-${applet.uuid}`;
        const hash = crypto.createHash('sha256').update(Buffer.from(imageData)).digest('base64');
        let needsUpdated = false;
        if (Object.keys(hashes).indexOf(hashKey) != -1) {
            if (hashes[hashKey] != hash) {
                needsUpdated = true;
            }
        } else {
            needsUpdated = true;
        }

        if (needsUpdated) {
            //Applet needs to be updated.
            config[device].sendingStatus.buf = new Uint8Array(imageData);
            config[device].sendingStatus.bufPos = 0;
            config[device].sendingStatus.currentHash.key = hashKey;
            config[device].sendingStatus.currentHash.hash = hash;

            publishToDevice(device, {
                command: "send_app_graphic",
                params: {
                    appid: applet.uuid
                }
            });

            config[device].dataTimeout = setTimeout(() => {
                publishToDevice(device, { command: "app_graphic_stop" });
                config[device].sendingStatus.isCurrentlySending = false;
            }, 15000);
        } else {
            config[device].sendingStatus.isCurrentlySending = false;
        }
    }
}

async function scheduleUpdateLoop(device) {
    if (config[device].connected == false) {
        return;
    }

    if (JSON.stringify(config[device].reducedSchedule) !== JSON.stringify(config[device].deviceReducedSchedule)) {
        let sched = config[device].reducedSchedule;
        config[device].reducedScheduleSHA = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(sched))).digest('base64');
    }

    const dev = config[device];
    if (dev.reducedScheduleSHA != dev.deviceReducedScheduleSHA) {
        let msg = {
            items: dev.reducedSchedule,
            hash: dev.reducedScheduleSHA
        }
        client.publish(`smartmatrix/${device}/schedule`, JSON.stringify(msg));
    } else {
        config[device].deviceReducedSchedule = JSON.parse(JSON.stringify(config[device].reducedSchedule));
    }
}

function deviceConnected(device) {
    config[device].currentApplet = -1;
    config[device].currentlyUpdatingApplet = -1;
    config[device].connected = true;
    config[device].sendingStatus.isCurrentlySending = false;
    config[device].sendingStatus.bufPos = 0;
    config[device].sendingStatus.buf = null;
}


function gotDeviceResponse(device, message) {
    config[device].offlineWatchdog.feed();
    if(config[device].connected == false) {
        deviceConnected(device);
    }
    if (message.type == "boot") {
        config[device].deviceReducedSchedule = [];
        config[device].deviceReducedScheduleSHA = "";
    }
    else if (message.type == "success") {
        if (message.next == "send_chunk") {
            clearTimeout(config[device].dataTimeout);
            config[device].dataTimeout = null;
            if (config[device].sendingStatus.bufPos <= config[device].sendingStatus.buf.length) {
                let chunk = config[device].sendingStatus.buf.slice(config[device].sendingStatus.bufPos, config[device].sendingStatus.bufPos + chunkSize);
                config[device].sendingStatus.bufPos += chunkSize;
                client.publish(`smartmatrix/${device}/applet`, chunk);
                config[device].dataTimeout = setTimeout(() => {
                    publishToDevice(device, { command: "app_graphic_stop" });
                }, 15000);
            } else {
                clearTimeout(config[device].dataTimeout);
                config[device].dataTimeout = null;
                publishToDevice(device, { command: "app_graphic_sent" });
                hashes[config[device].sendingStatus.currentHash.key] = config[device].sendingStatus.currentHash.hash;
                config[device].sendingStatus.isCurrentlySending = false;
            }
        } else if (message.info == "schedule_received") {
            config[device].deviceReducedScheduleSHA = message.hash;
        }
    } else if (message.type == "error") {
        console.log(`Receieved error state from device ${device}: ${message.info}`);
    }
}

function render(device, name, config) {
    return new Promise(async (resolve, reject) => {
        let configValues = [];
        for (const [k, v] of Object.entries(config)) {
            if (typeof v === 'object') {
                configValues.push(`${k}=${JSON.stringify(v)}`);
            } else {
                configValues.push(`${k}=${v}`);
            }
        }
        let outputError = "";
        let manifest = YAML.parse(fs.readFileSync(`${APPLET_FOLDER}/${name}/manifest.yaml`, 'utf-8'));
        let appletContents = fs.readFileSync(`${APPLET_FOLDER}/${name}/${manifest.fileName}`).toString();
        if (process.env.REDIS_HOSTNAME != undefined) {
            if (appletContents.indexOf(`load("cache.star", "cache")`) != -1) {
                const redis_connect_string = `cache_redis.connect("${process.env.REDIS_HOSTNAME}", "${process.env.REDIS_USERNAME}", "${process.env.REDIS_PASSWORD}")`
                appletContents = appletContents.replaceAll(`load("cache.star", "cache")`, `load("cache_redis.star", "cache_redis")\n${redis_connect_string}`);
                appletContents = appletContents.replaceAll(`cache.`, `cache_redis.`);
            }
        }
        fs.writeFileSync(`${APPLET_FOLDER}/${name}/${manifest.fileName.replace(".star", ".tmp.star")}`, appletContents);

        const renderCommand = spawn(`pixlet`, ['render', `${APPLET_FOLDER}/${name}/${manifest.fileName.replace(".star", ".tmp.star")}`, ...configValues, '-o', `/tmp/${device}-${manifest.fileName}.webp`], { timeout: 10000 });

        renderCommand.stdout.on('data', (data) => {
            outputError += data
        })

        renderCommand.stderr.on('data', (data) => {
            outputError += data
        })

        renderCommand.on('close', (code) => {
            if (code == 0) {
                if (outputError.indexOf("skip_execution") == -1 && fs.existsSync(`/tmp/${device}-${manifest.fileName}.webp`)) {
                    resolve(fs.readFileSync(`/tmp/${device}-${manifest.fileName}.webp`));
                } else {
                    reject("Applet requested to skip execution...");
                }
                fs.unlinkSync(`/tmp/${device}-${manifest.fileName}.webp`);
            } else {
                console.error(outputError);
                reject("Applet failed to render.");
            }
        });
    })
}

client.on('connect', function () {
    for (const [device, _] of Object.entries(config)) {
        client.subscribe(`smartmatrix/${device}/status`, function (err) {
            if (!err) {
                publishToDevice(device, {
                    command: "ping"
                });

                //Setup job to work on device.
                const update_task = new Task(`${device} update task`, () => {
                    appletUpdateLoop(device)
                });
                const schedule_task = new Task(`${device} schedule task`, () => {
                    scheduleUpdateLoop(device)
                });

                const update_job = new SimpleIntervalJob(
                    { seconds: 0.1, runImmediately: true },
                    update_task,
                    { id: `update_${device}` }
                );

                const schedule_job = new SimpleIntervalJob(
                    { seconds: 3, runImmediately: true },
                    schedule_task,
                    { id: `schedule_${device}` }
                );

                scheduler.addSimpleIntervalJob(update_job);
                scheduler.addSimpleIntervalJob(schedule_job);

                const dog = new Watchdog(20000);
                dog.on('reset', () => {
                    console.log(`Device ${device} disconnected.`);
                    config[device].connected = false;
                    config[device].sendingStatus.isCurrentlySending = false;
                    config[device].sendingStatus.bufPos = 0;
                    config[device].sendingStatus.buf = null;
                })
                dog.on('feed', () => {
                    config[device].connected = true;
                })

                config[device].offlineWatchdog = dog;
            } else {
                console.log(`Couldn't subscribe to ${device} status channel.`);
            }
        })
    }
});

client.on("disconnect", function () {
    scheduler.stop()
    client.reconnect();
});

client.on("error", function () {
    scheduler.stop();
    client.reconnect();
});

client.on("close", function () {
    scheduler.stop()
});

client.on('message', function (topic, message) {
    if (topic.indexOf("status") != -1) {
        const device = topic.split("/")[1];
        if (Object.keys(config).indexOf(device) != -1) {
            let data = JSON.parse(message);
            gotDeviceResponse(device, data);
        }
    }
})

process.once('SIGTERM', function (code) {
    console.log('SIGTERM received...');
    client.end(false);
});

