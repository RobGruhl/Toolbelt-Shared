// {{TITLE}} — Layout
// Page setup, margins, tab indicators, headers/footers

#import "theme.typ": *

// Pandoc compatibility
#let horizontalrule = line(length: 100%, stroke: 0.5pt + luma(200))

// === Page Dimensions ===
#let page-width   = {{PAGE_WIDTH}}
#let page-height  = {{PAGE_HEIGHT}}
#let gutter       = {{GUTTER}}   // binding side
#let margin-top   = 0.65in
#let margin-bottom = 0.6in

// Thumb index dimensions
#let thumb-width  = 0.35in
#let thumb-gap    = 0.08in
#let margin-outer = 0.5in + thumb-width + thumb-gap
#let thumb-tick   = 1pt

// === State ===
#let current-section = state("current-section", none)
#let current-section-title = state("current-section-title", none)

#let get-section-color(sec-order) = {
  let c = color-gray
  for (key, sec) in sections {
    if sec.order == sec-order { c = sec.color }
  }
  c
}

// === Thumb Index ===
#let draw-thumb-index(active-order, page-side) = {
  let pad = 0.125in
  let avail-height = page-height - margin-top - margin-bottom - 2 * pad
  let slot-height = avail-height / total-tabs
  let start-y = pad

  for (key, sec) in sections {
    let y-offset = (sec.order - 1) * slot-height
    let is-active = sec.order == active-order

    if is-active {
      place(
        top + if page-side == "right" { right } else { left },
        dx: 0pt,
        dy: start-y + y-offset,
        rect(
          width: thumb-width,
          height: slot-height,
          fill: sec.color,
          {
            set text(size: 5.5pt, weight: "bold", fill: white, font: font-heading)
            align(center + horizon,
              rotate(-90deg, reflow: true,
                text(sec.tab)
              )
            )
          }
        )
      )
    } else {
      place(
        top + if page-side == "right" { right } else { left },
        dx: 0pt,
        dy: start-y + y-offset + slot-height / 2 - 0.5pt,
        rect(
          width: thumb-width * 0.4,
          height: thumb-tick,
          fill: sec.color.lighten(40%),
        )
      )
    }
  }
}

// === Section Break ===
#let section-start(key) = {
  let sec = sections.at(key)
  current-section.update(sec.order)
  current-section-title.update(sec.tab)
}

// === Main Document Template ===
#let guide(
  title: "{{TITLE}}",
  body
) = {
  set document(title: title, author: "{{AUTHOR}}")

  set page(
    width: page-width,
    height: page-height,
    margin: (
      top: margin-top,
      bottom: margin-bottom,
      inside: gutter,
      outside: margin-outer,
    ),

    header: context {
      let sec-order = current-section.get()
      let sec-title = current-section-title.get()
      if sec-order != none {
        let sec-color = get-section-color(sec-order)
        set text(size: small-size, font: font-heading)
        grid(
          columns: (1fr, auto),
          align: (left, right),
          text(fill: sec-color, weight: "bold", sec-title),
          text(fill: sec-color.lighten(30%), title),
        )
        v(-2pt)
        line(length: 100%, stroke: 0.75pt + sec-color)
      }
    },

    footer: context {
      let sec-order = current-section.get()
      let sec-color = if sec-order != none { get-section-color(sec-order) } else { color-gray }
      line(length: 100%, stroke: 0.5pt + sec-color.lighten(50%))
      v(2pt)
      set text(size: small-size, font: font-heading)
      let page-num = counter(page).display("1")
      if calc.odd(counter(page).get().first()) {
        align(right, text(fill: sec-color, page-num))
      } else {
        align(left, text(fill: sec-color, page-num))
      }
    },

    background: context {
      let sec-order = current-section.get()
      if sec-order != none {
        let pg = counter(page).get().first()
        let side = if calc.odd(pg) { "right" } else { "left" }
        draw-thumb-index(sec-order, side)
      }
    },
  )

  // Typography
  set text(size: body-size, font: font-body, lang: "en")

  show heading.where(level: 1): it => context {
    let sec-order = current-section.get()
    let c = get-section-color(sec-order)
    pagebreak(weak: true)
    v(0.3in)
    block(text(size: h1-size, weight: "bold", font: font-heading, fill: c, it.body))
    v(0.15in)
    line(length: 100%, stroke: 1.5pt + c)
    v(0.15in)
  }

  show heading.where(level: 2): it => context {
    let sec-order = current-section.get()
    let c = get-section-color(sec-order)
    v(0.15in)
    block(text(size: h2-size, weight: "bold", font: font-heading, fill: c, it.body))
    v(0.08in)
  }

  show heading.where(level: 3): it => {
    v(0.1in)
    block(text(size: h3-size, weight: "bold", font: font-heading, it.body))
    v(0.05in)
  }

  show heading.where(level: 4): it => {
    v(0.08in)
    block(text(size: h4-size, weight: "bold", font: font-heading, style: "italic", it.body))
    v(0.03in)
  }

  // Tables
  set table(
    stroke: 0.5pt + luma(180),
    inset: (x: 6pt, y: 5pt),
    align: left + top,
    fill: (_, y) => if y == 0 { luma(230) },
  )
  show table: set text(size: small-size, hyphenate: true)
  show table.cell.where(y: 0): set text(weight: "bold")

  // Code blocks
  show raw.where(block: true): it => {
    set text(size: tiny-size, font: font-mono)
    block(width: 100%, fill: luma(245), inset: 8pt, radius: 3pt, it)
  }
  show raw.where(block: false): it => {
    set text(size: small-size, font: font-mono)
    box(fill: luma(240), inset: (x: 3pt, y: 1pt), radius: 2pt, it)
  }

  show strong: set text(weight: "bold")
  set par(leading: 0.6em, justify: true)
  set block(spacing: 0.7em)
  set list(indent: 0.3in, body-indent: 0.15in)
  set enum(indent: 0.3in, body-indent: 0.15in)

  body
}
