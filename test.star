load("render.star", "render")
load("encoding/base64.star", "base64")

OURA_LOGO = base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAUAAAAHCAYAAADAp4fuAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABaADAAQAAAABAAAABwAAAAAFak+RAAAAKklEQVQIHWNkAIL/QACiQYARCCAsNBIsiqESWQCkAcRnQtMJ5mIVxGomAEH0FADMipNBAAAAAElFTkSuQmCC")

def main():
    return render.Root(
        child = render.Row(
            children = [render.Padding(pad=(1,0,0,0), child=render.Column(expanded=True, main_align="space_evenly", cross_align="center", children=[
                render.Text("READY", font="5x8"),
                render.Text("86", font="6x13")
            ])), render.Plot(
            data = [
                (0, 3.35),
                (1, 2.15),
                (2, 2.37),
                (3, -0.31),
                (4, -3.53),
                (5, 1.31),
                (6, -1.3),
                (7, 4.60)
            ],
            width = 38,
            height = 32,
            color = "#0f0",
            color_inverted = "#F33",
            x_lim = (0, 7),
            y_lim = (-5, 5),
            fill = True,
        )], main_align="space_between", expanded=True)
    )