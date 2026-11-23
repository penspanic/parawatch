# Pictures and videos on a card

`parawatch guide attachments` prints this page for the installed version.

The human looks at the pictures before reading the body. So each picture says what it is on the picture itself, and the pictures that belong together sit together. Do not describe pictures by their place in the body ("the first picture", "left to right: now, A, B", "rows from the top"): that makes the human count, and the order changes when the panel is narrow.

## Caption every picture

`--attach "<caption>=<file>"` puts a short caption under the picture, in the panel and in the viewer. A caption is a few words in the human's words: what the picture shows, not its file name.

```
parawatch ask -p game "Switch the halo to the outline?" -o "Outline" -o "Keep it" \
  --attach "Now=/abs/halo-now.png" --attach "Outline=/abs/halo-outline.png"
```

A value without `=` is a plain file, as before. A file whose own name holds `=` still works: the split is at the first `=` followed by a path.

## Tie a picture to its choice

When each choice has its own picture, `--option-attach "<choice>=<attachments>"` puts the choice's number on the picture, and pointing at a choice lights its pictures and dims the rest.

```
parawatch ask -p game "Which ending?" -o "Side tank" -o "Top box" -r 2 \
  --attach "Side tank=/abs/side.png" --attach "Top box=/abs/top.png" \
  --option-attach "1=Side tank" --option-attach "2=Top box"
```

## Compare in one place

Before and after, on and off, A and B: `--compare "<a>,<b>[,...]"` shows them as one picture with a tab for each. The human flips between them in the same spot, so a small difference shows. In the viewer the zoom stays put while flipping, and videos keep their moment.

```
parawatch try -p game "Did the trail get better?" \
  --attach "Trail off=/abs/off.mp4" --attach "Trail on=/abs/on.mp4" --compare "Trail off,Trail on"
```

Several comparisons on one card each get their own `--compare`. Pointing at a choice flips every comparison to that choice's picture, when `--option-attach` ties them.

## A grid of one size

`--grid <columns>` lays the pictures out in columns of one width, so the same object in several looks lines up. The panel drops columns when it is too narrow.

```
parawatch try -p game "Three bottles after the fix" --grid 3 \
  --attach "Candy jar=/abs/a.png" --attach "Piggy bank=/abs/b.png" --attach "Perfume=/abs/c.png"
```

## Attach the captures, not a sheet

Let parawatch line the pictures up instead of joining them into one sheet with an image tool: each capture as its own file with a caption, `--compare` for the looks of one thing, `--grid` for the lineup. The human can then open any one at full size, and nothing in a sheet needs explaining. A sheet you already have is one attachment with one caption; if it has rows and columns, write their names on the sheet itself.

## Names in the other flags

`--compare` and `--option-attach` name attachments by caption, by file name or by place (1, 2, ...), comma separated. An unknown name fails and lists the names there are.

## Changing them

While nobody has answered, `parawatch edit <card>` replaces them: `--attach` again with every file (captions included), or only `--compare`, `--option-attach` or `--grid` to change the layout and keep the files. `--grid 0` goes back to the usual rows.

After opening a card with two or more pictures and no captions, or with a body that points at pictures by their place, the command prints a hint on stderr with the edit to make.

## Where the files live

Attach with absolute paths under your home folder or the shared folder (or a folder named with `parawatch sync root`), so the human's other machines can open them. Short videos are fine; the panel plays them in place.
