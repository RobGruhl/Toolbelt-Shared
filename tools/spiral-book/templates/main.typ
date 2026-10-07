// {{TITLE}}
// Main assembly file: cover, table of contents, then every chapter in order.

#import "template/layout.typ": *
#import "template/theme.typ": *

#show: guide.with(title: "{{TITLE}}")

// === Cover Page ===
// Cover art is optional and comes from outside this pipeline (any image generator, a
// designer, a photo). Drop a 2:3 portrait image at guide/cover.png and uncomment this block.
// #page(header: none, footer: none, background: none, margin: 0pt)[
//   #image("cover.png", width: 100%, height: 100%, fit: "cover")
// ]

// === Table of Contents ===
#page(header: none, footer: none, background: none, margin: (top: margin-top, bottom: margin-bottom, inside: gutter, outside: margin-outer))[
  #text(size: h1-size, weight: "bold", font: font-heading, fill: color-{{FIRST_COLOR}})[Contents]
  #v(0.1in)
  #line(length: 100%, stroke: 1.5pt + color-{{FIRST_COLOR}})
  #v(0.15in)
  #set text(size: 8pt)
  #set par(leading: 0.45em)
  #outline(title: none, indent: 0.15in, depth: 1)
]

// === Chapters ===
{{CHAPTERS}}
