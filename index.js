require('dotenv').config()

const fs = require('fs');
const { spawn } = require("child_process");
const YAML = require("yaml");
const axios = require('axios');
var crypto = require('crypto');
const { createClient } = require('redis');
const mqtt = require('mqtt');

const serverConfig = {
    redis: {
        hostname: process.env.REDIS_HOSTNAME,
        username: process.env.REDIS_USERNAME,
        password: process.env.REDIS_PASSWORD
    },
    mqtt: {
        host: process.env.MQTT_HOST,
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD
    },
    tidbyt: {
        refreshToken: process.env.TIDBYT_REFRESH_JWT,
        apiKey: process.env.TIDBYT_API_KEY
    },
}

const mqttClient = mqtt.connect(serverConfig.mqtt.host, {
    username: serverConfig.mqtt.username,
    password: serverConfig.mqtt.password
});

const redis = createClient({
    url: `redis://${serverConfig.redis.username}:${serverConfig.redis.password}@${serverConfig.redis.hostname}`
});

redis.on("error", (e) => {
    console.error(e);
})

let { SPRITE_FOLDER, DEVICE_FOLDER } = process.env
if (SPRITE_FOLDER === undefined) {
    console.log("SPRITE_FOLDER not set, using `/sprites` ...");
    SPRITE_FOLDER = "/sprites";
}

if (DEVICE_FOLDER === undefined) {
    console.log("DEVICE_FOLDER not set, using `/devices` ...");
    DEVICE_FOLDER = "/devices";
}

let config = {};

async function updateDeviceConfigs() {
    const dir = fs.readdirSync(DEVICE_FOLDER);
    for (const file of dir) {
        if (file.includes(".json")) {
            const deviceID = file.split(".json")[0];
            const val = JSON.parse(fs.readFileSync(`${DEVICE_FOLDER}/${file}`));

            if (config[deviceID] == undefined) {
                config[deviceID] = {
                    schedule: [],
                    currentlyUpdatingSprite: 0
                }
            }
            config[deviceID].schedule = val;
            for (var i = 0; i < val.length; i++) {

                config[deviceID].schedule[i].is_skipped = false;
                config[deviceID].schedule[i].is_pinned = false;
            }

            mqttClient.subscribe(`smartmatrix/${deviceID}/status`);
            mqttClient.subscribe(`smartmatrix/${deviceID}/error`);
        }
    }
}

async function updateDeviceSprite(device, spriteID) {
    const sprite = config[device].schedule[spriteID];
    if (sprite == undefined) {
        return;
    }

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
            let url = `https://prod.tidbyt.com/app-server/preview/${sprite.name}.webp?${confStr}&v=${Date.now()}`;
            const apiToken = await getTidbytRendererToken();
            imageData = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    "Authorization": `Bearer ${apiToken}`
                }
            });
            imageData = imageData.data;
        } else {
            imageData = await render(device, sprite.name, sprite.config ?? {})
        }
    } catch (e) {
        if (!e.includes("Sprite requested to skip execution...")) {
            console.log(e);
        }
    }

    if (imageData != null) {
        config[device].schedule[spriteID].is_skipped = false;

        //Check if sprite needs to be pushed to device before sending
        const newHash = crypto.createHash("sha256").update(imageData).digest("hex");
        const currentHash = await redis.get(`smx:device:${device}:spriteHashes:${spriteID}`);
        if (currentHash != newHash) {
            const message = JSON.stringify({
                spriteID: spriteID,
                spriteSize: imageData.length,
                encodedSpriteSize: imageData.toString("base64").length,
                data: imageData.toString("base64")
            });

            mqttClient.publish(`smartmatrix/${device}/sprite_delivery`, message);
            await redis.set(`smx:device:${device}:spriteHashes:${spriteID}`, newHash, {
                EX: 3600 * 6
            });
        }
    } else {
        config[device].schedule[spriteID].is_skipped = true;
    }

    await updateDeviceSchedule(device);
}

async function updateDeviceSchedule(device) {
    if (config[device].connected == false) {
        return;
    }

    let currentReducedSchedule = [];
    for (const v of config[device].schedule) {
        let reducedScheduleItem = {
            duration: v.duration ?? 5,
            skipped: v.is_skipped ?? false,
            pinned: v.pinned ?? false
        };
        currentReducedSchedule.push(reducedScheduleItem);
    }

    let currentScheduleHash = crypto.createHash('md5').update(Buffer.from(JSON.stringify(currentReducedSchedule))).digest('base64');
    let deviceScheduleHash = await redis.get(`smx:device:${device}:scheduleHash`);
    if (currentScheduleHash != deviceScheduleHash) {
        mqttClient.publish(`smartmatrix/${device}/schedule_delivery`, JSON.stringify(currentReducedSchedule));
        await redis.set(`smx:device:${device}:scheduleHash`, currentScheduleHash);
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
        let manifest = YAML.parse(fs.readFileSync(`${SPRITE_FOLDER}/${name}/manifest.yaml`, 'utf-8'));
        let spriteContents = fs.readFileSync(`${SPRITE_FOLDER}/${name}/${manifest.fileName}`).toString();

        if (serverConfig.redis.hostname != undefined) {
            if (spriteContents.indexOf(`load("cache.star", "cache")`) != -1) {
                const redis_connect_string = `cache_redis.connect("${serverConfig.redis.hostname}", "${serverConfig.redis.username}", "${serverConfig.redis.password}")`
                spriteContents = spriteContents.replaceAll(`load("cache.star", "cache")`, `load("cache_redis.star", "cache_redis")\n${redis_connect_string}`);
                spriteContents = spriteContents.replaceAll(`cache.`, `cache_redis.`);
            }
        }
        fs.writeFileSync(`${SPRITE_FOLDER}/${name}/${manifest.fileName.replace(".star", ".tmp.star")}`, spriteContents);

        const renderCommand = spawn(`pixlet`, ['render', `${SPRITE_FOLDER}/${name}/${manifest.fileName.replace(".star", ".tmp.star")}`, ...configValues, '-o', `/tmp/${device}-${manifest.fileName}.webp`], { timeout: 10000 });

        renderCommand.stdout.on('data', (data) => {
            outputError += data
        })

        renderCommand.stderr.on('data', (data) => {
            outputError += data
        })

        renderCommand.on('close', (code) => {
            if (code == 0) {
                if (outputError.indexOf("skip_execution") == -1) {
                    if (fs.existsSync(`/tmp/${device}-${manifest.fileName}.webp`)) {
                        const fileContents = fs.readFileSync(`/tmp/${device}-${manifest.fileName}.webp`);
                        fs.unlinkSync(`/tmp/${device}-${manifest.fileName}.webp`);
                        resolve(fileContents);
                    } else {
                        reject("Sprite not found on disk...");
                    }
                } else {
                    if (fs.existsSync(`/tmp/${device}-${manifest.fileName}.webp`)) {
                        fs.unlinkSync(`/tmp/${device}-${manifest.fileName}.webp`);
                    }
                    reject("Sprite requested to skip execution...");
                }
            } else {
                console.error(outputError);
                reject("Sprite failed to render.");
            }
        });
    })
}

async function getTidbytRendererToken() {
    const existingToken = await redis.get("smx:tidbytApiToken");
    if (existingToken == null) {
        const refreshTokenBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(serverConfig.tidbyt.refreshToken)}`;
        const refreshTokenResponse = await axios.post(`https://securetoken.googleapis.com/v1/token?key=${serverConfig.tidbyt.apiKey}`, refreshTokenBody, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            }
        });
        const accessToken = refreshTokenResponse.data.access_token;
        await redis.set("smx:tidbytApiToken", accessToken, {
            EX: 3600
        });
        return accessToken;
    } else {
        return existingToken;
    }
}

mqttClient.on('connect', async () => {
    redis.connect().then(() => {
        updateDeviceConfigs();
    });
})

mqttClient.on('message', async (topic, payload) => {
    const device = topic.split("/")[1];
    try {
        if (topic.includes("status")) {
            payload = JSON.parse(payload);
            if (payload.type == "get_schedule") {
                await redis.del(`smx:device:${device}:scheduleHash`);
                updateDeviceSchedule(device);
            } else if (payload.type == "report") {
                const currentSpriteID = payload.currentSpriteID;
                const nextSpriteID = payload.nextSpriteID;
                if (nextSpriteID > currentSpriteID) {
                    if (nextSpriteID - currentSpriteID > 1) {
                        //a sprite was skipped in the middle
                        for (var i = currentSpriteID; i < nextSpriteID; i++) {
                            updateDeviceSprite(device, i);
                        }
                    }
                } else {
                    if (nextSpriteID != 0) {
                        //a sprite was skipped at the beginning
                        for (var i = 0; i < nextSpriteID; i++) {
                            updateDeviceSprite(device, i);
                        }
                    }
                    if (nextSpriteID == 0 && currentSpriteID != config[device].schedule.length) {
                        //a sprite was skipped at the end
                        for (var i = currentSpriteID; i < config[device].schedule.length; i++) {
                            updateDeviceSprite(device, i);
                        }
                    }
                }

                setTimeout(() => {
                    updateDeviceSprite(device, nextSpriteID)
                }, (config[device].schedule[currentSpriteID].duration * 1000) - 2000);
            }
        } else if (topic.includes("error")) {
            payload = JSON.parse(payload);
            const erroredSpriteID = payload.spriteID;
            await redis.del(`smx:device:${device}:spriteHashes:${erroredSpriteID}`);

            setTimeout(() => {
                updateDeviceSprite(device, erroredSpriteID)
            }, 100);
        }
    } catch (e) {
        console.error(`[main] couldn't parse message ${payload} from ${device}: `, e);
    }
})

mqttClient.on('disconnect', () => {
    console.log(`[main] disconnected, cleanly exiting.`);
    process.exit(1);
})