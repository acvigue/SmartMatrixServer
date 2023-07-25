
# SmartMatrixServer

[![GPLv3 License](https://img.shields.io/badge/License-GPL%20v3-yellow.svg)](https://opensource.org/licenses/)
[![CodeFactor](https://www.codefactor.io/repository/github/acvigue/smartmatrixserver/badge)](https://www.codefactor.io/repository/github/acvigue/smartmatrixserver)

SmartMatrixServer is a MQTT-based helper that serves as the backend for the SmartMatrix-IDF project.

## Run with Docker Compose

```yml
  smx:
    image: ghcr.io/acvigue/smartmatrixserver:main
    volumes:
      - ./tidbytcommunity/apps:/apps
      - ./devices:/devices
    environment:
      REDIS_HOSTNAME: redis
      REDIS_USERNAME: default
      REDIS_PASSWORD: redispassword
      MQTT_HOSTNAME: ~~~~~~~
      MQTT_USERNAME: ~~~~~~~
      MQTT_PASSWORD: ~~~~~~~
      DEVICE_FOLDER: /devices
      SPRITE_FOLDER: /apps
  redis:
    image: redis:alpine
    command: redis-server --requirepass redispassword
    volumes: 
      - ./redis_data:/data
```


## Configuration

Files should be stored in the containers attached `/config` directory as `SmartMatrixXXXXXX.json` where XXXXXX is the last 6 characters of the ESP32's MAC address

Array of objects containing name, duration, and any required configuration parameters.

Applets must be stored in the container with the format `/applets/[name]/[name].star`

```json
[
    {
      "name": "paraland",
      "duration": 10,
      "config": {
        "image": "north_carolina_morning"
      }
    },
    {
      "name": "paraland",
      "duration": 10,
      "config": {
        "image": "arizona_day"
      }
    },
]
```
