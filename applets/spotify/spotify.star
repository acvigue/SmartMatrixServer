load("render.star", "render")
load("encoding/base64.star", "base64")
load("encoding/json.star", "json")
load("cache.star", "cache")
load("http.star", "http")
load("schema.star", "schema")
load("time.star", "time")

def songTitle(title):
    return render.Padding(pad=(2,0,0,0), child=render.Marquee(
        width=60,
        child=render.Padding(pad=(0,2,0,0), child=render.Text(title, color="#1db954")),
    ))
    
def detailText(name):
    return render.Marquee(
        width=41,
        child=render.Text(name.upper()),
    )

def errorView(message):
    return render.WrappedText(
        content=message,
        width=64,
        color="#fff",
    )

def main(config):
    if 'refresh_token' not in config:
        return render.Root(child=errorView("no refresh token"))

    if 'client_id' not in config:
        return render.Root(child=errorView("no client id"))

    if 'client_secret' not in config:
        return render.Root(child=errorView("no client secret"))

    auth_dto = cache.get("auth_token")
    auth_token = None
    if auth_dto == None:
        print("Getting Spotify access token")
        refresh_body={
            'grant_type': 'refresh_token',
            'refresh_token': config['refresh_token']
        }

        rep = http.post('https://accounts.spotify.com/api/token', form_body=refresh_body, auth=(config["client_id"], config["client_secret"]))
        if rep.status_code != 200:
            return render.Root(
                child=errorView("Auth request failed.")
            )
        auth_token = rep.json()
        cache.set("auth_token", json.encode(auth_token), ttl_seconds=3600)
    else:
        auth_token = json.decode(auth_dto)
    access_token = auth_token["access_token"]

    rep = http.get('https://api.spotify.com/v1/me/player/currently-playing', headers={
        "Authorization": "Bearer " + access_token
    })
    if rep.status_code != 200:
        print("skip_execution")
        return render.Root(
                child=errorView("Skip execution!")
            )
    track = rep.json()

    trackTitle = track["item"]["name"]
    trackImage = cache.get(track["item"]["album"]["images"][0]["url"])
    if trackImage == None:
        rep = http.get(track["item"]["album"]["images"][0]["url"])
        trackImage = rep.body()
        cache.set(track["item"]["album"]["images"][0]["url"], trackImage)

    artist = track["item"]["artists"][0]["name"]
    album = track["item"]["album"]["name"]

    lastColumn = None
    if album != trackTitle:
        lastColumn = [detailText(artist), render.Padding(pad=(0,1,0,0), child=detailText(album))]
    else:
        lastColumn = [detailText(artist)]

    return render.Root(
        child=render.Column(children=[
            songTitle(trackTitle.upper()),
            render.Padding(pad=(2,2,0,0), child=
                render.Row(children=[
                    render.Image(src=trackImage, height=17, width=17),
                    render.Padding(pad=(2,0,0,0), child=
                        render.Column(children=lastColumn)
                    )
                ])
            )
        ])
    )

def get_schema():
    return schema.Schema(
        version = "1",
        fields = [
            schema.Text(
                id = "refresh_token",
                name = "Spotify Refresh Token",
                desc = "",
                icon = "user",
            ),
            schema.Text(
                id = "client_id",
                name = "Spotify App Client ID",
                desc = "",
                icon = "key"
            ),
            schema.Text(
                id = "client_secret",
                name = "Spotify App Client Secret",
                desc = "",
                icon = "key"
            )
        ],
    )

def cal_average(num):
    sum_num = 0
    for t in num:
        sum_num = sum_num + t           

    avg = sum_num / len(num)
    return avg