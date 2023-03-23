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
let chunkSize = 10000;

let config = {};

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
    schedule = JSON.parse(schedule);

    config[device] = {
        currentApplet: 0,
        currentlyUpdatingApplet: -1,
        connected: false,
        updateState: {
            bufPos: 0,
            buf: null,
            inProgress: false,
            currentHash: ""
        },
        offlineWatchdog: null,
        dataTimeout: null,
        schedule: schedule,
        deviceScheduleHash: null,
        appletHashes: []
    }
}

directory.closeSync()

function sendDeviceCommand(device, obj) {
    let serializedAsBuffer = JSON.stringify(obj);
    client.publish(`smartmatrix/${device}/command`, serializedAsBuffer);
}

async function updateAppletLoop(device) {
    if (config[device].updateState.inProgress || config[device].connected == false) {
        return;
    }

    config[device].updateState.inProgress = true;
    config[device].currentlyUpdatingApplet++;

    if (config[device].currentlyUpdatingApplet >= config[device].schedule.length) {
        config[device].currentlyUpdatingApplet = 0;
    }

    const appletID = config[device].currentlyUpdatingApplet.toString();

    const applet = config[device].schedule[config[device].currentlyUpdatingApplet];
    const appletExternal = applet.external ?? false;
    let imageData = null;

    try {
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

            imageData = await axios.get(url, {
                responseType: 'arraybuffer'
            });
            imageData = imageData.data;
        } else {
            imageData = await render(device, applet.name, applet.config ?? {})
        }
    } catch (e) {

    }

    if (imageData != null) {
        config[device].schedule[config[device].currentlyUpdatingApplet].skip = false;

        //Check if applet needs to be pushed to device before sending
        const hash = crypto.createHash('sha256').update(Buffer.from(imageData)).digest('base64');

        if (config[device].appletHashes[appletID] != hash) {
            //Applet needs to be updated.
            config[device].updateState.buf = new Uint8Array(imageData);
            config[device].updateState.bufPos = 0;
            config[device].updateState.currentHash = hash;

            sendDeviceCommand(device, {
                command: "send_app_graphic",
                params: {
                    appid: appletID
                }
            });

            config[device].dataTimeout = setTimeout(() => {
                sendDeviceCommand(device, { command: "app_graphic_stop" });
                config[device].updateState.inProgress = false;
            }, 5000);
        } else {
            config[device].updateState.inProgress = false;
        }
    } else {
        config[device].schedule[config[device].currentlyUpdatingApplet].skip = true;
        config[device].updateState.inProgress = false;
    }
}

async function scheduleUpdateLoop(device) {
    if (config[device].connected == false) {
        return;
    }

    let currentReducedSchedule = [];
    for (const v of config[device].schedule) {
        let reducedScheduleItem = {
            d: v.duration ?? 5,
            s: v.skip ?? false,
            p: v.pinned ?? false
        };
        currentReducedSchedule.push(reducedScheduleItem);
    }

    let currentReducedScheduleSHA = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(currentReducedSchedule))).digest('base64');
    if (currentReducedScheduleSHA != config[device].deviceScheduleHash) {
        let msg = {
            items: currentReducedSchedule,
            hash: currentReducedScheduleSHA
        }
        client.publish(`smartmatrix/${device}/schedule`, JSON.stringify(msg));
    }
}

function deviceConnected(device) {
    config[device].currentApplet = -1;
    config[device].currentlyUpdatingApplet = -1;
    config[device].connected = true;
    config[device].updateState.inProgress = false;
    config[device].updateState.bufPos = 0;
    config[device].updateState.buf = null;
}


function gotDeviceResponse(device, message) {
    config[device].offlineWatchdog.feed();
    if (config[device].connected == false) {
        deviceConnected(device);
    }
    if (message.type == "boot") {
        //On boot, send schedule and updated applets
        config[device].deviceScheduleHash = "";
        config[device].appletHashes = [];
    }
    else if (message.type == "success") {
        if (message.info == "applet_displayed") {
            config[device].currentApplet = message.appid;
        } else if (message.info == "applet_update") {
            clearTimeout(config[device].dataTimeout);
            config[device].dataTimeout = null;
            if (message.next == "send_chunk") {
                if (config[device].updateState.bufPos <= config[device].updateState.buf.length) {
                    let chunk = config[device].updateState.buf.slice(config[device].updateState.bufPos, config[device].updateState.bufPos + chunkSize);
                    config[device].updateState.bufPos += chunkSize;
                    client.publish(`smartmatrix/${device}/applet`, chunk);
                    config[device].dataTimeout = setTimeout(() => {
                        sendDeviceCommand(device, { command: "app_graphic_stop" });
                        config[device].updateState.inProgress = false;
                    }, 5000);
                } else {
                    sendDeviceCommand(device, { command: "app_graphic_sent" });
                    config[device].appletHashes[config[device].currentlyUpdatingApplet] = config[device].updateState.currentHash;
                    config[device].updateState.inProgress = false;
                }
            }
        } else if (message.info == "schedule_received") {
            config[device].deviceScheduleHash = message.hash;
        }
    } else if (message.type == "error") {
        console.log(`Receieved error state from device ${device}: ${message.info}`);
        if (message.info == "malformed_applet") {
            config[device].appletHashes[message.appid] = null;
            let check = setInterval(function() {
                if(!config[device].updateState.inProgress) {
                    config[device].currentlyUpdatingApplet = message.appid - 1;
                    clearInterval(check);
                }
            }, 100);
        }
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
                sendDeviceCommand(device, {
                    command: "ping"
                });

                //Setup job to work on device.
                const update_task = new Task(`${device} update task`, () => {
                    updateAppletLoop(device)
                });
                const schedule_task = new Task(`${device} schedule task`, () => {
                    scheduleUpdateLoop(device)
                });

                const update_job = new SimpleIntervalJob(
                    { seconds: 0.5, runImmediately: true },
                    update_task,
                    { id: `update_${device}` }
                );

                const schedule_job = new SimpleIntervalJob(
                    { seconds: 5, runImmediately: true },
                    schedule_task,
                    { id: `schedule_${device}` }
                );

                scheduler.addSimpleIntervalJob(update_job);
                scheduler.addSimpleIntervalJob(schedule_job);

                const dog = new Watchdog(20000);
                dog.on('reset', () => {
                    console.log(`Device ${device} disconnected.`);
                    config[device].connected = false;
                    config[device].updateState.inProgress = false;
                    config[device].updateState.bufPos = 0;
                    config[device].updateState.buf = null;
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
            try {
                let data = JSON.parse(message);
                gotDeviceResponse(device, data);
            } catch (e) {

            }
        }
    }
})

process.once('SIGTERM', function (code) {
    console.log('SIGTERM received...');
    client.end(false);
});

