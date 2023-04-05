const mqtt = require('mqtt')
const fs = require('fs');
const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler');
const { Watchdog } = require("watchdog");
const { spawn } = require("child_process");
const YAML = require("yaml");
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
var crypto = require('crypto');
const { createClient } = require('redis');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

/*

Required environment variables for sprite-sender to function
MQTT_[HOSTNAME,USERNAME,PASSWORD]
REDIS_[HOSTNAME,USERNAME,PASSWORD],
[CONFIG,APPLET]_FOLDER

*/

const serverConfig = {
    redis: {
        hostname: process.env.REDIS_HOSTNAME || "mqtt.vigue.me",
        username: process.env.REDIS_USERNAME || "default",
        password: process.env.REDIS_PASSWORD || "TmLEzg4SqZR3tiH82wnauSBhSShQ6owj"
    },
    mqtt: {
        hostname: process.env.MQTT_HOSTNAME || "mqtt://mqtt.vigue.me",
        username: process.env.MQTT_USERNAME || "hv7WWIVpskRWjNseGNHPKjbW5PtESoOH",
        password: process.env.MQTT_PASSWORD || "dVIWG3f5IjhP5GMGQoszIzcO1k25g98z"
    },
    r2: {
        accountID: process.env.R2_ACCOUNT_ID || "9add4187b89e0aac0e5a951c893549dd",
        accessKeyID: "e89594cf58e1bfcffdc75ea713cd08fd",
        secretAccessKey: "220e8bc74ef54c7351f3bfefefdd3d32dcd252900ea14117bb6a4c7d7639e615"
    }
}

const client = mqtt.connect(serverConfig.mqtt.hostname, {
    username: serverConfig.mqtt.username,
    password: serverConfig.mqtt.password
});

const redis = createClient({
    url: `redis://${serverConfig.redis.username}:${serverConfig.redis.password}@${serverConfig.redis.hostname}`
});

redis.on("error", (e) => {
    console.error(e);
})

const S3 = new S3Client({
    region: "auto",
    endpoint: `https://${serverConfig.r2.accountID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: serverConfig.r2.accessKeyID,
        secretAccessKey: serverConfig.r2.secretAccessKey,
    },
});

let { CONFIG_FOLDER } = process.env
if (CONFIG_FOLDER === undefined) {
    console.log("CONFIG_FOLDER not set, using `/config` ...");
    CONFIG_FOLDER = "/config";
}

let { APPLET_FOLDER } = process.env
if (APPLET_FOLDER === undefined) {
    console.log("APPLET_FOLDER not set, using `/sprites` ...");
    APPLET_FOLDER = "/sprites";
}

const scheduler = new ToadScheduler();
let chunkSize = 1000000;

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
        currentSprite: 0,
        currentlyUpdatingSprite: -1,
        connected: false,
        offlineWatchdog: null,
        schedule: schedule,
        isUpdating: false
    }
}

directory.closeSync()

function sendDeviceCommand(device, obj) {
    let serializedAsBuffer = JSON.stringify(obj);
    client.publish(`smartmatrix/${device}/command`, serializedAsBuffer);
}

async function updateDeviceSprite(device, id, url) {
    if (config[device].connected == false || config[device].isUpdating) {
        return;
    }

    const command = {
        type: "new_sprite",
        params: {
            spriteID: parseInt(id),
            url: url
        }
    }
    config[device].isUpdating = true;
    sendDeviceCommand(device, command);
}

async function updateSpriteLoop(device) {
    if (config[device].connected == false || config[device].isUpdating) {
        return;
    }

    config[device].currentlyUpdatingSprite++;

    if (config[device].currentlyUpdatingSprite >= config[device].schedule.length) {
        config[device].currentlyUpdatingSprite = 0;
    }

    const spriteID = config[device].currentlyUpdatingSprite.toString();

    const sprite = config[device].schedule[config[device].currentlyUpdatingSprite];
    const spriteExternal = sprite.external ?? false;
    let imageData = null;

    try {
        if (spriteExternal) {
            let configValues = [];
            for (const [k, v] of Object.entries(sprite.config)) {
                if (typeof v === 'object') {
                    configValues.push(`${k}=${encodeURIComponent(JSON.stringify(v))}`);
                } else {
                    configValues.push(`${k}=${encodeURIComponent(v)}`);
                }
            }
            let confStr = configValues.join("&");
            let url = `https://prod.tidbyt.com/app-server/preview/${sprite.name}.webp?${confStr}`;

            imageData = await axios.get(url, {
                responseType: 'arraybuffer'
            });
            imageData = imageData.data;
        } else {
            imageData = await render(device, sprite.name, sprite.config ?? {})
        }
    } catch (e) {

    }

    if (imageData != null) {
        config[device].schedule[config[device].currentlyUpdatingSprite].skip = false;

        //Check if sprite needs to be pushed to device before sending
        const newHash = crypto.createHash("md5").update(imageData).digest("base64");
        const currentHash = await redis.get(`smx:device:${device}:sprites:${spriteID}`);

        if (currentHash != newHash) {
            await S3.send(
                new PutObjectCommand({Bucket: "smartmatrix", Key: `sprites/${device}/${spriteID}.webp`, Body: imageData})
            );
            let url = `http://pub-34eaf0d2dcbb40c396065db28dcc4418.r2.dev/sprites/${device}/${spriteID}.webp`;
            updateDeviceSprite(device, spriteID, url);
        }
    } else {
        config[device].schedule[config[device].currentlyUpdatingSprite].skip = true;
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

    let currentScheduleHash = crypto.createHash('md5').update(Buffer.from(JSON.stringify(currentReducedSchedule))).digest('base64');
    let deviceScheduleHash = await redis.get(`smx:device:${device}:scheduleHash`);
    if (currentScheduleHash != deviceScheduleHash) {
        let msg = {
            type: "new_schedule",
            hash: currentScheduleHash,
            schedule: currentReducedSchedule
        }
        sendDeviceCommand(device, msg);
    }
}

function deviceConnected(device) {
    config[device].currentSprite = -1;
    config[device].currentlyUpdatingSprite = -1;
    config[device].connected = true;
}


async function gotDeviceResponse(device, message) {
    console.log(message);
    config[device].offlineWatchdog.feed();
    if (config[device].connected == false) {
        deviceConnected(device);
    }
    if (message.type == "boot") {
        config[device].isUpdating = false;
        await redis.del(`smx:device:${device}:scheduleHash`);
    }
    else if (message.type == "sprite_loaded") {
        config[device].isUpdating = false;
        await redis.set(`smx:device:${device}:sprites:${message.params.id}`, message.params.hash);
    } else if(message.type == "schedule_loaded") {
        await redis.set(`smx:device:${device}:scheduleHash`, message.hash);
    } else if(message.type == "sprite_shown") {
        config[device].currentSprite = message.spriteID;
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
        let spriteContents = fs.readFileSync(`${APPLET_FOLDER}/${name}/${manifest.fileName}`).toString();
        if (serverConfig.redis.hostname != undefined && 1 == 0) {
            if (spriteContents.indexOf(`load("cache.star", "cache")`) != -1) {
                const redis_connect_string = `cache_redis.connect("${serverConfig.redis.hostname}", "${serverConfig.redis.username}", "${serverConfig.redis.password}")`
                spriteContents = spriteContents.replaceAll(`load("cache.star", "cache")`, `load("cache_redis.star", "cache_redis")\n${redis_connect_string}`);
                spriteContents = spriteContents.replaceAll(`cache.`, `cache_redis.`);
            }
        }
        fs.writeFileSync(`${APPLET_FOLDER}/${name}/${manifest.fileName.replace(".star", ".tmp.star")}`, spriteContents);

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
                    reject("Sprite requested to skip execution...");
                }
                fs.unlinkSync(`/tmp/${device}-${manifest.fileName}.webp`);
            } else {
                console.error(outputError);
                reject("Sprite failed to render.");
            }
        });
    })
}

client.on('connect', async function () {
    await redis.connect();

    for (const [device, _] of Object.entries(config)) {
        client.subscribe(`smartmatrix/${device}/status`, function (err) {
            if (!err) {
                sendDeviceCommand(device, {
                    type: "ping"
                });

                //Setup job to work on device.
                const update_task = new Task(`${device} update task`, () => {
                    try {
                        updateSpriteLoop(device)
                    } catch (e) {

                    }
                });
                const schedule_task = new Task(`${device} schedule task`, () => {
                    scheduleUpdateLoop(device)
                });

                const update_job = new SimpleIntervalJob(
                    { seconds: 2, runImmediately: true },
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

client.on('message', async function (topic, message) {
    if (topic.indexOf("status") != -1) {
        const device = topic.split("/")[1];
        if (Object.keys(config).indexOf(device) != -1) {
            try {
                let data = JSON.parse(message);
                await gotDeviceResponse(device, data);
            } catch (e) {
                console.error(e);
            }
        }
    }
})

process.once('SIGTERM', function (code) {
    console.log('SIGTERM received...');
    client.end(false);
});

