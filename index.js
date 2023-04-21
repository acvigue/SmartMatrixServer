const fs = require('fs');
const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler');
const { spawn } = require("child_process");
const YAML = require("yaml");
const axios = require('axios');
var crypto = require('crypto');
const { createClient } = require('redis');
const { S3Client, PutObjectCommand, ListObjectsCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { IoTDataPlaneClient, UpdateThingShadowCommand } = require("@aws-sdk/client-iot-data-plane");

const serverConfig = {
    redis: {
        hostname: process.env.REDIS_HOSTNAME,
        username: process.env.REDIS_USERNAME,
        password: process.env.REDIS_PASSWORD
    },
    aws: {
        accessKeyID: process.env.AWS_KEY_ID,
        secretAccessKey: process.env.AWS_KEY_SECRET
    },
    tidbyt: {
        refreshToken:  process.env.TIDBYT_REFRESH_JWT,
        apiKey: process.env.TIDBYT_API_KEY
    }
}

const redis = createClient({
    url: `redis://${serverConfig.redis.username}:${serverConfig.redis.password}@${serverConfig.redis.hostname}`
});

redis.on("error", (e) => {
    console.error(e);
})

const S3 = new S3Client({
    region: "us-east-1",
    credentials: {
        accessKeyId: serverConfig.aws.accessKeyID,
        secretAccessKey: serverConfig.aws.secretAccessKey,
    },
});

const iotDataPlaneClient = new IoTDataPlaneClient({
    region: "us-east-1",
    credentials: {
        accessKeyId: serverConfig.aws.accessKeyID,
        secretAccessKey: serverConfig.aws.secretAccessKey,
    },
});

let { SPRITE_FOLDER } = process.env
if (SPRITE_FOLDER === undefined) {
    console.log("SPRITE_FOLDER not set, using `/sprites` ...");
    SPRITE_FOLDER = "/sprites";
}

const scheduler = new ToadScheduler();

let config = {};

async function updateDeviceConfigs() {
    const listObjectsCommandParams = {
        Bucket: "smartmatrixconfigs",
    };
    const resp = await S3.send(new ListObjectsCommand(listObjectsCommandParams));
    const items = resp.Contents;
    for (const item of items) {
        const deviceID = item.Key.split(".")[0];
        const getObjectCommandParams = { // GetObjectRequest
            Bucket: "smartmatrixconfigs", // required
            Key: item.Key, // required
        };
        const objectData = await S3.send(new GetObjectCommand(getObjectCommandParams));
        objectData.Body.transformToString("utf-8").then((val) => {
            const jsonVal = JSON.parse(val);
            if (config[deviceID] == undefined) {
                config[deviceID] = {
                    schedule: [],
                    currentlyUpdatingSprite: 0
                }
                schedulerRegisterNewDevice(deviceID);
            }
            config[deviceID].schedule = jsonVal;
            for (var i = 0; i < jsonVal.length; i++) {

                config[deviceID].schedule[i].is_skipped = false;
                config[deviceID].schedule[i].is_pinned = false;
            }
        })
    }
}

async function updateSpriteLoop(device) {
    config[device].currentlyUpdatingSprite++;

    if (config[device].currentlyUpdatingSprite >= config[device].schedule.length) {
        config[device].currentlyUpdatingSprite = 0;
    }

    const spriteID = config[device].currentlyUpdatingSprite.toString();
    const sprite = config[device].schedule[config[device].currentlyUpdatingSprite];
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
            let url = `https://prod.tidbyt.com/app-server/preview/${sprite.name}.webp?${confStr}`;
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
        console.error(e)
    }

    if (imageData != null) {
        config[device].schedule[config[device].currentlyUpdatingSprite].is_skipped = false;

        //Check if sprite needs to be pushed to device before sending
        const newHash = crypto.createHash("md5").update(imageData).digest("base64");
        const currentHash = await redis.get(`smx:device:${device}:sprites:${spriteID}`);
        if (currentHash != newHash) {
            await S3.send(
                new PutObjectCommand({ Bucket: "smartmatrixsprites", Key: `${device}/${spriteID}.webp`, Body: imageData })
            );
            await redis.set(`smx:device:${device}:sprites:${spriteID}`, newHash, {
                EX: 3600 + Math.floor(Math.random() * 1800) + 1
            });
        }
    } else {
        config[device].schedule[config[device].currentlyUpdatingSprite].is_skipped = true;
    }
}

async function scheduleUpdateLoop(device) {
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
        const newDesiredShadowState = {
            state: {
                desired: {
                    schedule: currentReducedSchedule
                }
            }
        };

        const updateThingShadowParams = {
            thingName: device,
            payload: JSON.stringify(newDesiredShadowState)
        };

        try {
            await iotDataPlaneClient.send(new UpdateThingShadowCommand(updateThingShadowParams));
            await redis.set(`smx:device:${device}:scheduleHash`, currentScheduleHash);
        } catch (e) {
            console.error("couldn't update device shadow!", e);
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
        let manifest = YAML.parse(fs.readFileSync(`${SPRITE_FOLDER}/${name}/manifest.yaml`, 'utf-8'));
        let spriteContents = fs.readFileSync(`${SPRITE_FOLDER}/${name}/${manifest.fileName}`).toString();
        if (serverConfig.redis.hostname != undefined && 1 == 0) {
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

async function schedulerRegisterNewDevice(deviceID) {
    //Setup job to work on device.
    const update_task = new Task(`${deviceID} update task`, () => {
        try {
            updateSpriteLoop(deviceID)
        } catch (e) {

        }
    });
    const schedule_task = new Task(`${deviceID} schedule task`, () => {
        scheduleUpdateLoop(deviceID)
    });

    const update_job = new SimpleIntervalJob(
        { seconds: 0.5, runImmediately: true },
        update_task,
        { id: `update_${deviceID}` }
    );

    const schedule_job = new SimpleIntervalJob(
        { seconds: 10, runImmediately: true },
        schedule_task,
        { id: `schedule_${deviceID}` }
    );

    scheduler.addSimpleIntervalJob(update_job);
    scheduler.addSimpleIntervalJob(schedule_job);
}

const update_configs_task = new Task(`update configs task`, async () => {
    try {
        await updateDeviceConfigs();
    } catch (e) {
        console.error("couldn't get device configs", e);
    }
});

const update_configs_job = new SimpleIntervalJob(
    { seconds: 30, runImmediately: true },
    update_configs_task,
    { id: `update_configs` }
);

redis.connect().then(() => {
    scheduler.addSimpleIntervalJob(update_configs_job);
});