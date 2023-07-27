import 'dotenv/config'

import fs from 'fs'
import { spawn } from 'child_process'
import { parse as parseYAML } from 'yaml'
import axios from 'axios'

import { createHash } from 'crypto'
import { createClient as createRedisClient } from 'redis'
import { connect as createMQTTClient } from 'mqtt'
import { type SpriteConfig, type Device } from 'types'

const serverConfig = {
  redis: {
    hostname: process.env.REDIS_HOSTNAME ?? '',
    username: process.env.REDIS_USERNAME ?? '',
    password: process.env.REDIS_PASSWORD ?? ''
  },
  mqtt: {
    host: process.env.MQTT_HOST ?? '',
    username: process.env.MQTT_USERNAME ?? '',
    password: process.env.MQTT_PASSWORD ?? ''
  },
  tidbyt: {
    refreshToken: process.env.TIDBYT_REFRESH_JWT ?? '',
    apiKey: process.env.TIDBYT_API_KEY ?? ''
  },
  folders: {
    devices: process.env.DEVICE_FOLDER ?? '/devices',
    sprites: process.env.SPRITE_FOLDER ?? '/sprites'
  }
}

const mqttClient = createMQTTClient(serverConfig.mqtt.host, {
  username: serverConfig.mqtt.username,
  password: serverConfig.mqtt.password
})

const redis = createRedisClient({
  url: `redis://${serverConfig.redis.username}:${serverConfig.redis.password}@${serverConfig.redis.hostname}`
})

redis.on('error', (e) => {
  console.error('Redis client reported error. Stopping', e)
  process.exit(0)
})

mqttClient.on('error', (e) => {
  console.error('MQTT client reported error. Stopping.', e)
  cleanExit()
})

// Config is an object. Keys are device names.
const config: Record<string, Device> = {}

async function updateDeviceConfigs (): Promise<void> {
  const dir = fs.readdirSync(serverConfig.folders.devices)
  for (const file of dir) {
    if (file.includes('.json')) {
      const deviceID = file.split('.json')[0]
      console.log(`Initializing device: ${deviceID}`)
      let val = JSON.parse(
        fs.readFileSync(`${serverConfig.folders.devices}/${file}`).toString()
      ) as SpriteConfig[]

      if (config[deviceID] === undefined) {
        config[deviceID] = {
          schedule: [],
          currentlyUpdatingSprite: 0
        }
      }

      if (
        serverConfig.tidbyt.apiKey === '' ||
        serverConfig.tidbyt.refreshToken === ''
      ) {
        console.warn(
          'Missing configuration for TIDBYT_API_KEY and/or TIDBYT_REFRESH_JWT, external sprite rendering disabled.'
        )
        val = val.filter((sprite) => {
          return sprite.external === null || sprite.external === false
        })
      }

      config[deviceID].schedule = val
      for (let i = 0; i < val.length; i++) {
        config[deviceID].schedule[i].is_skipped = false
        config[deviceID].schedule[i].is_pinned = false
      }

      mqttClient.subscribe(`smartmatrix/${deviceID}/status`)
      mqttClient.subscribe(`smartmatrix/${deviceID}/error`)
      await updateDeviceSchedule(deviceID)
    }
  }
}

async function updateDeviceSprite (
  device: string,
  spriteID: number
): Promise<void> {
  const sprite = config[device].schedule[spriteID]
  if (sprite === undefined) {
    return
  }

  const spriteExternal = sprite.external ?? false
  let imageData = null

  try {
    if (spriteExternal) {
      const configValues = []
      for (const [k, v] of Object.entries(sprite.config)) {
        if (typeof v === 'object') {
          configValues.push(`${k}=${encodeURIComponent(JSON.stringify(v))}`)
        } else {
          configValues.push(`${k}=${encodeURIComponent(v)}`)
        }
      }
      const confStr = configValues.join('&')
      const url = `https://prod.tidbyt.com/app-server/preview/${
        sprite.name
      }.webp?${confStr}&v=${Date.now()}`
      const apiToken = await getTidbytRendererToken()
      imageData = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
          Authorization: `Bearer ${apiToken}`
        }
      })
      imageData = imageData.data
    } else {
      imageData = await render(device, sprite.name, sprite.config)
    }
  } catch (e) {}

  if (imageData != null) {
    config[device].schedule[spriteID].is_skipped = false

    // Check if sprite needs to be pushed to device before sending
    const newHash = createHash('sha256').update(imageData).digest('hex')
    const currentHash = await redis.get(
      `smx:device:${device}:spriteHashes:${spriteID}`
    )
    if (currentHash !== newHash) {
      const message = JSON.stringify({
        spriteID,
        spriteSize: imageData.length,
        encodedSpriteSize: imageData.toString('base64').length,
        data: imageData.toString('base64')
      })

      mqttClient.publish(`smartmatrix/${device}/sprite_delivery`, message)
      await redis.set(
        `smx:device:${device}:spriteHashes:${spriteID}`,
        newHash,
        {
          EX: 3600 * 6
        }
      )
    }
  } else {
    config[device].schedule[spriteID].is_skipped = true
  }

  await updateDeviceSchedule(device)
}

async function updateDeviceSchedule (device: string): Promise<void> {
  const currentReducedSchedule = []
  for (const v of config[device].schedule) {
    const reducedScheduleItem = {
      duration: v.duration ?? 5,
      skipped: v.is_skipped ?? false,
      pinned: v.is_pinned ?? false
    }
    currentReducedSchedule.push(reducedScheduleItem)
  }

  const currentScheduleHash = createHash('md5')
    .update(Buffer.from(JSON.stringify(currentReducedSchedule)))
    .digest('base64')
  const deviceScheduleHash = await redis.get(
    `smx:device:${device}:scheduleHash`
  )
  if (currentScheduleHash !== deviceScheduleHash) {
    console.log(`Publishing updated schedule for ${device}`)
    mqttClient.publish(
      `smartmatrix/${device}/schedule_delivery`,
      JSON.stringify(currentReducedSchedule)
    )
    await redis.set(`smx:device:${device}:scheduleHash`, currentScheduleHash)
  }
}

async function render (
  device: string,
  name: string,
  config: any
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const configValues = []
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === 'object') {
        configValues.push(`${k}=${JSON.stringify(v)}`)
      } else {
        configValues.push(`${k}=${v as string}`)
      }
    }
    let outputError = ''
    const manifest = parseYAML(
      fs.readFileSync(
        `${serverConfig.folders.sprites}/${name}/manifest.yaml`,
        'utf-8'
      )
    ) as {
      fileName: string
    }

    const renderCommand = spawn(
      'pixlet',
      [
        'render',
        `${serverConfig.folders.sprites}/${name}/${manifest.fileName}`,
        ...configValues,
        '-o',
        `/tmp/${device}-${manifest.fileName}.webp`
      ],
      { timeout: 10000 }
    )

    renderCommand.stdout.on('data', (data: string) => {
      outputError += data
    })

    renderCommand.stderr.on('data', (data: string) => {
      outputError += data
    })

    renderCommand.on('close', (code) => {
      if (code === 0) {
        if (!outputError.includes('skip_execution')) {
          if (fs.existsSync(`/tmp/${device}-${manifest.fileName}.webp`)) {
            const fileContents = fs.readFileSync(
              `/tmp/${device}-${manifest.fileName}.webp`
            )
            fs.unlinkSync(`/tmp/${device}-${manifest.fileName}.webp`)
            resolve(fileContents)
          } else {
            reject(new Error('Sprite not found on disk...'))
          }
        } else {
          if (fs.existsSync(`/tmp/${device}-${manifest.fileName}.webp`)) {
            fs.unlinkSync(`/tmp/${device}-${manifest.fileName}.webp`)
          }
          reject(new Error('Sprite requested to skip execution...'))
        }
      } else {
        console.error(outputError)
        reject(new Error('Sprite failed to render.'))
      }
    })
  })
}

async function getTidbytRendererToken (): Promise<string> {
  const existingToken = await redis.get('smx:tidbytApiToken')
  if (existingToken == null) {
    const refreshTokenBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(
      serverConfig.tidbyt.refreshToken
    )}`
    const refreshTokenResponse = await axios.post(
      `https://securetoken.googleapis.com/v1/token?key=${serverConfig.tidbyt.apiKey}`,
      refreshTokenBody,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    )
    const accessToken = refreshTokenResponse.data.access_token as string
    await redis.set('smx:tidbytApiToken', accessToken, {
      EX: 3600
    })
    return accessToken
  } else {
    return existingToken
  }
}

mqttClient.on('connect', () => {
  console.log('MQTT connection established!')
  void redis.connect().then(() => {
    console.log('Redis connection established!')
    void updateDeviceConfigs()
  })
})

mqttClient.on('message', (topic, payload) => {
  const device = topic.split('/')[1]
  try {
    if (topic.includes('status')) {
      const JSONPayload = JSON.parse(payload.toString())
      if (JSONPayload.type === 'get_schedule') {
        void redis.del(`smx:device:${device}:scheduleHash`).then(() => {
          void updateDeviceSchedule(device)
        })
      } else if (JSONPayload.type === 'report') {
        const currentSpriteID = JSONPayload.currentSpriteID
        const nextSpriteID = JSONPayload.nextSpriteID
        if (nextSpriteID > currentSpriteID) {
          if (nextSpriteID - currentSpriteID > 1) {
            // a sprite was skipped in the middle
            for (let i = currentSpriteID; i < nextSpriteID; i++) {
              void updateDeviceSprite(device, i)
            }
          }
        } else {
          if (nextSpriteID !== 0) {
            // a sprite was skipped at the beginning
            for (let i = 0; i < nextSpriteID; i++) {
              void updateDeviceSprite(device, i)
            }
          }
          if (
            nextSpriteID === 0 &&
            currentSpriteID !== config[device].schedule.length
          ) {
            // a sprite was skipped at the end
            for (
              let i = currentSpriteID;
              i < config[device].schedule.length;
              i++
            ) {
              void updateDeviceSprite(device, i)
            }
          }
        }

        setTimeout(() => {
          void updateDeviceSprite(device, nextSpriteID)
        }, config[device].schedule[currentSpriteID].duration * 1000 - 2000)
      }
    } else if (topic.includes('error')) {
      const JSONPayload = JSON.parse(payload.toString())
      const erroredSpriteID = JSONPayload.spriteID
      void redis.del(
        `smx:device:${device}:spriteHashes:${erroredSpriteID as string}`
      )

      setTimeout(() => {
        void updateDeviceSprite(device, erroredSpriteID)
      }, 100)
    }
  } catch (e) {
    console.error(
      `Couldn't parse message ${payload.toString()} from ${device}: `,
      e
    )
  }
})

mqttClient.on('disconnect', () => {
  console.log('MQTT disconnected, exiting...')
  cleanExit()
})

function cleanExit (): void {
  void redis.disconnect()
  mqttClient.removeAllListeners()
  mqttClient.end()
}

process.on('SIGTERM', () => {
  console.info('SIGTERM signal received.')
  cleanExit()
})
