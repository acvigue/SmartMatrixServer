
# SmartMatrixServer

> Part of the SmartMatrix project.

SmartMatrix Server is an application that schedules the delivery of compiled Starlark applets to end devices over MQTT.

## Run with Docker Compose

```yml
  panel-led-mqtt:
    image: ghcr.io/acvigue/plm-applet-sender:main
    volumes:
      - ./applets:/applets
      - ./config:/config
    environment:
      REDIS_HOSTNAME: redis
      REDIS_USERNAME: default
      REDIS_PASSWORD: redispassword
      MQTT_HOSTNAME: ~~~~~~~
      MQTT_USERNAME: ~~~~~~~
      MQTT_PASSWORD: ~~~~~~~
      CONFIG_FOLDER: /config
      APPLET_FOLDER: /applets
  redis:
    image: redis:alpine
    command: redis-server --requirepass redispassword
    volumes: 
      - ./redis_data:/data
```


## Configuration

Files should be stored in the containers attached `/config` directory as `( ESP.getChipID() ).json`

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
