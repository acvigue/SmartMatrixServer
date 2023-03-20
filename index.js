const mqtt = require('mqtt')
const fs = require('fs');
const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler');
const { Watchdog } = require("watchdog");
const {spawn} = require("child_process");
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
let hashes = {};

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
    schedule = JSON.parse(schedule);
    schedule.forEach((v, i) => {
        schedule[i]["uuid"] = ((uuidv4()).slice(0, 8));
        schedule[i]["skip"] = false;
    })

    config[device] = {
        currentApplet: -1,
        currentlyUpdatingApplet: -1,
        currentAppletStartedAt: 0,
        connected: false,
        sendingStatus: {
            bufPos: 0,
            buf: null,
            isCurrentlySending: false
        },
        waitingForDisplayAck: false,
        offlineWatchdog: null,
        schedule: schedule
    }
}

directory.closeSync()

function publishToDevice(device, obj) {
    const msg = JSON.stringify(obj);
    client.publish(`smartmatrix/${device}/command`, msg);
}

async function appletDisplayLoop(device) {
    if(config[device].connected == false || config[device].waitingForDisplayAck) {
        return;
    }

    const nextAppletNeedsRunAt = config[device].currentAppletStartedAt + (config[device].schedule[config[device].currentApplet+1].duration * 1000);
    
    if(Date.now() > nextAppletNeedsRunAt) {
        //Find next unskipped applet.
        while(true) {
            config[device].currentApplet++;

            if(config[device].currentApplet >= (config[device].schedule.length - 1)) {
                config[device].currentApplet = 0;
            }

            const applet = config[device].schedule[config[device].currentApplet];
            if(!applet.skip) {
                //Attempt to display applet on device.
                publishToDevice(device, {
                    command: "display_app_graphic",
                    params: {
                        appid: applet.uuid
                    }
                });
                config[device].waitingForDisplayAck = true;
                break;
            }
        }
    }
}

async function appletUpdateLoop(device) {
    if(config[device].sendingStatus.isCurrentlySending || config[device].connected == false) {
        return;
    }

    config[device].sendingStatus.isCurrentlySending = true;
    config[device].currentlyUpdatingApplet++;

    const applet = config[device].schedule[config[device].currentlyUpdatingApplet];

    console.log(`Checking updates for applet ${applet.uuid}: ${applet.name}`);

    const appletExternal = applet.external ?? false;
    let imageData = null;
    if(appletExternal) {
        let configValues = [];
        for(const [k, v] of Object.entries(applet.config)) {
            if(typeof v === 'object') {
                configValues.push(`${k}=${encodeURIComponent(JSON.stringify(v))}`);
            } else {
                configValues.push(`${k}=${encodeURIComponent(v)}`);
            }
        }
        let confStr = configValues.join("&");
        let url = `https://prod.tidbyt.com/app-server/preview/${applet.name}.webp?${confStr}`;

        imageData = await axios.get(url, {
            responseType: 'arraybuffer'
        }).catch((e) => {
            console.log(`Applet ${applet.uuid} (${applet.name}) returned error: `, e);
            config[device].schedule[config[device].currentlyUpdatingApplet].skip = true;
            config[device].sendingStatus.isCurrentlySending = false;
            if(config[device].currentlyUpdatingApplet >= (config[device].schedule.length - 1)) {
                config[device].currentlyUpdatingApplet = -1;
            }
        });
        imageData = imageData.data;
    } else {
        imageData = await render(applet.name, applet.config ?? {}).catch((e) => {
            //upon failure, skip applet and retry.
            console.log(`Applet ${applet.uuid} (${applet.name}) returned error: `, e);
            config[device].schedule[config[device].currentlyUpdatingApplet].skip = true;
            config[device].sendingStatus.isCurrentlySending = false;
            if(config[device].currentlyUpdatingApplet >= (config[device].schedule.length - 1)) {
                config[device].currentlyUpdatingApplet = -1;
            }
        })
    }

    if(config[device].sendingStatus.isCurrentlySending) {
        config[device].schedule[config[device].currentlyUpdatingApplet].skip = false;

        //Check if applet needs to be pushed to device before sending
        const hash = crypto.createHash('sha256').update(Buffer.from(imageData)).digest('base64');
        let needsUpdated = false;
        if(Object.keys(hashes).indexOf(applet.uuid) != -1) {
            if(hashes[applet.uuid] != hash) {
                needsUpdated = true;
            }
        } else {
            needsUpdated = true;
        }
        hashes[applet.uuid] = hash;

        if(needsUpdated) {
            //Applet needs to be updated.
            config[device].sendingStatus.buf = new Uint8Array(imageData);
            config[device].sendingStatus.bufPos = 0;
            
            publishToDevice(device, {
                command: "send_app_graphic",
                params: {
                    appid: applet.uuid
                }
            });
        } else {
            config[device].sendingStatus.isCurrentlySending = false;
        }
    }

    if(config[device].currentlyUpdatingApplet >= (config[device].schedule.length - 1)) {
        config[device].currentlyUpdatingApplet = -1;
    }

    config[device].jobRunning = false;
}

function gotDeviceResponse(device, message) {
    if(message.type == "heartbeat") {
        config[device].offlineWatchdog.feed();
    } else if(message.type == "success") {
        if(message.next == "send_chunk") {
            if(config[device].sendingStatus.bufPos <= config[device].sendingStatus.buf.length) {
                let chunk = config[device].sendingStatus.buf.slice(config[device].sendingStatus.bufPos, config[device].sendingStatus.bufPos+chunkSize);
                config[device].sendingStatus.bufPos += chunkSize;
                client.publish(`smartmatrix/${device}/applet`, chunk);
            } else {
                publishToDevice(device, {command: "app_graphic_sent"});
                config[device].sendingStatus.isCurrentlySending = false;
            }
        } else if(message.info == "applet_displayed") {
            config[device].waitingForDisplayAck = false;
            config[device].currentAppletStartedAt = Date.now();
        }
    } else if(message.type == "error") {
        config[device].waitingForDisplayAck = false;
        if(message.info == "not_found") {
            config[device].currentAppletStartedAt = 0;
        } else {
            console.log(`Receieved error state from device ${device}: ${message.info}`);
        }
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

        const renderCommand = spawn(`pixlet`, ['render', `${APPLET_FOLDER}/${name}/${manifest.fileName.replace(".star",".tmp.star")}`,...configValues,'-o',`/tmp/${manifest.fileName}.webp`]);
    
        var timeout = setTimeout(() => {
            console.log(`Rendering timed out for ${name}`);
            try {
              process.kill(renderCommand.pid, 'SIGKILL');
            } catch (e) {
              console.log('Could not kill process ^', e);
            }
            reject("Applet failed to render.");
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
                    resolve(fs.readFileSync(`/tmp/${manifest.fileName}.webp`));
                } else {
                    reject("Applet requested to skip execution...");
                }
                fs.unlinkSync(`/tmp/${manifest.fileName}.webp`);
            } else {
                console.error(outputError);
                reject("Applet failed to render.");
            }
        });
    })
}

client.on('connect', function () {
    for(const [device, _] of Object.entries(config)) {
        client.subscribe(`smartmatrix/${device}/status`, function (err) {
            if (!err) {
                publishToDevice(device, {
                    command: "ping"
                });

                //Setup job to work on device.
                const display_task = new Task(`${device} display task`, () => {
                    appletDisplayLoop(device)
                });
                const update_task = new Task(`${device} update task`, () => {
                    appletUpdateLoop(device)
                });
                
                const display_job = new SimpleIntervalJob(
                    { seconds: 5, runImmediately: true },
                    display_task,
                    { id: `display_${device}` }
                );

                const update_job = new SimpleIntervalJob(
                    { seconds: 1, runImmediately: true },
                    update_task,
                    { id: `update_${device}` }
                );

                scheduler.addSimpleIntervalJob(display_job);
                scheduler.addSimpleIntervalJob(update_job);

                const dog = new Watchdog(20000);
                dog.on('reset', () => {
                    console.log(`Device ${device} disconnected.`);
                    config[device].connected = false;
                    config[device].sendingStatus.isCurrentlySending = false;
                    config[device].sendingStatus.bufPos = 0;
                    config[device].sendingStatus.buf = null;
                })
                dog.on('feed',  () => {
                    config[device].connected = true;
                })

                config[device].offlineWatchdog = dog;
            } else {
                console.log(`Couldn't subscribe to ${device} status channel.`);
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
    if(topic.indexOf("status") != -1) {
      const device = topic.split("/")[1];
      gotDeviceResponse(device, JSON.parse(message));
    }
})

process.once('SIGTERM', function (code) {
    console.log('SIGTERM received...');
    client.end(false);
});