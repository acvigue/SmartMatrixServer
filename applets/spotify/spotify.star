load("render.star", "render")
load("encoding/base64.star", "base64")
load("encoding/json.star", "json")
load("cache.star", "cache")
load("http.star", "http")
load("schema.star", "schema")
load("time.star", "time")

def songTitle(title):
    return render.Marquee(
        width=64,
        child=render.Text("this won't fit in 64 pixels"),
        offset_start=5,
        offset_end=32,
    )

def errorView(message):
    return render.WrappedText(
        content=message,
        width=64,
        color="#fff",
    )

def main(config):
    if 'apikey' not in config:
        return render.Root(child=errorView("no API key"))

    now = time.now()
    from_date = (now - time.parse_duration(str(int(config['days'])*24)+'h')).format("2006-01-02")
    to_date = now.format("2006-01-02")

    sleep_data = None
    sleep_dto = cache.get("sleep_data")
    if sleep_dto != None:
        print("Hit! Using cached sleep data.")
        sleep_data = json.decode(sleep_dto)
    else:
        print("Miss! Calling Sleep API.")
        rep = http.get('https://api.ouraring.com/v2/usercollection/daily_sleep?start_date='+from_date+'&'+'end_date='+to_date, headers={"Authorization": "Bearer " + config['apikey']})
        if rep.status_code != 200:
            fail("Sleep request failed with status:", rep.status_code)
        sleep_data = rep.json()
        cache.set("sleep_data", json.encode(sleep_data), ttl_seconds = 1800)

    activity_data = None
    activity_dto = cache.get("activity_data")
    if activity_dto != None:
        print("Hit! Using cached activity data.")
        activity_data = json.decode(activity_dto)
    else:
        print("Miss! Calling activity API.")
        rep = http.get('https://api.ouraring.com/v2/usercollection/daily_activity?start_date='+from_date+'&'+'end_date='+to_date, headers={"Authorization": "Bearer " + config['apikey']})
        if rep.status_code != 200:
            fail("activity request failed with status:", rep.status_code)
        activity_data = rep.json()
        cache.set("activity_data", json.encode(activity_data), ttl_seconds = 1800)

    readiness_data = None
    readiness_dto = cache.get("readiness_data")
    if readiness_dto != None:
        print("Hit! Using cached readiness data.")
        readiness_data = json.decode(readiness_dto)
    else:
        print("Miss! Calling readiness API.")
        rep = http.get('https://api.ouraring.com/v2/usercollection/daily_readiness?start_date='+from_date+'&'+'end_date='+to_date, headers={"Authorization": "Bearer " + config['apikey']})
        if rep.status_code != 200:
            fail("readiness request failed with status:", rep.status_code)
        readiness_data = rep.json()
        cache.set("readiness_data", json.encode(readiness_data), ttl_seconds = 1800)

    #Populate array of last 7 scores.
    sleep_scores = []
    for day in sleep_data["data"]:
        sleep_scores.append(int(day["score"]))

    activity_scores = []
    for day in activity_data["data"]:
        activity_scores.append(int(day["score"]))

    readiness_scores = []
    for day in readiness_data["data"]:
        readiness_scores.append(int(day["score"]))

    return render.Root(
        delay = 2000,
        child = render.Animation(
            children = [
                readinessView(readiness_scores, activity_scores, sleep_scores),
                activityView(readiness_scores, activity_scores, sleep_scores),
                sleepView(readiness_scores, activity_scores, sleep_scores)
            ],
        ),
    )

def get_schema():
    return schema.Schema(
        version = "1",
        fields = [
            schema.Text(
                id = "apikey",
                name = "Oura PAT",
                desc = "Oura API Personal Access Token",
                icon = "user",
            ),
            schema.Text(
                id = "days",
                name = "Graph Lookback",
                desc = "Previous days to show on graph",
                icon = "calendar",
                default = "7"
            )
        ],
    )

def cal_average(num):
    sum_num = 0
    for t in num:
        sum_num = sum_num + t           

    avg = sum_num / len(num)
    return avg