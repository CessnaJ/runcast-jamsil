import AppKit
import CoreText
import ImageIO
import UniformTypeIdentifiers

struct Row: Decodable { let label: String; let value: String }
struct Card: Decodable { let label: String; let rows: [Row] }
struct Copy: Decodable { let header: [String]; let cards: [Card]; let footer: [String] }

let backgroundURL = URL(fileURLWithPath: CommandLine.arguments[1])
let copyURL = URL(fileURLWithPath: CommandLine.arguments[2])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[3])
let fontURL = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
  .appendingPathComponent("assets/Pretendard-SemiBold.otf")
guard CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil) else {
  fatalError("Cannot load the guide's Korean text font")
}
let copy = try JSONDecoder().decode(Copy.self, from: Data(contentsOf: copyURL))
guard let source = CGImageSourceCreateWithURL(backgroundURL as CFURL, nil),
      let artwork = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fatalError("Cannot read guide artwork") }
let width: CGFloat = 724, height: CGFloat = 2172, scale: CGFloat = 2
guard artwork.width == Int(width), artwork.height == Int(height) else { fatalError("Unexpected artwork dimensions") }
guard let bitmap = CGContext(data: nil, width: Int(width*scale), height: Int(height*scale),
  bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("Cannot allocate image") }
bitmap.interpolationQuality = .high
bitmap.draw(artwork, in: CGRect(x: 0, y: 0, width: width*scale, height: height*scale))
bitmap.translateBy(x: 0, y: height*scale)
bitmap.scaleBy(x: scale, y: -scale)
bitmap.setShouldAntialias(true)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: bitmap, flipped: true)

func color(_ hex: UInt32) -> NSColor {
  NSColor(srgbRed: CGFloat((hex >> 16) & 255)/255, green: CGFloat((hex >> 8) & 255)/255,
    blue: CGFloat(hex & 255)/255, alpha: 1)
}
let white = color(0xEDF4EF), mint = color(0xB6F542), cyan = color(0xA6E5DB)
func attributes(_ size: CGFloat, _ color: NSColor, bold: Bool = false) -> [NSAttributedString.Key: Any] {
  guard let font = NSFont(name: bold ? "AppleSDGothicNeo-Bold" : "Pretendard-SemiBold", size: size) else {
    fatalError("The Korean typesetting font is unavailable")
  }
  let paragraph = NSMutableParagraphStyle()
  paragraph.lineBreakMode = .byWordWrapping
  paragraph.lineSpacing = 1
  return [.font: font, .foregroundColor: color, .paragraphStyle: paragraph, .kern: 0]
}
func textHeight(_ text: String, width: CGFloat, size: CGFloat, bold: Bool = false) -> CGFloat {
  ceil((text as NSString).boundingRect(with: CGSize(width: width, height: 2000),
    options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes(size, white, bold: bold)).height) + 2
}
func draw(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat, color: NSColor = white, bold: Bool = false, height: CGFloat? = nil) {
  let boxHeight = height ?? textHeight(text, width: width, size: size, bold: bold)
  (text as NSString).draw(with: CGRect(x: x, y: y, width: width, height: boxHeight),
    options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes(size, color, bold: bold))
}

draw(copy.header[0], x: 35, y: 22, width: 650, size: 34, bold: true)
draw(copy.header[1], x: 35, y: 69, width: 654, size: 48, bold: true)
draw(copy.header[2], x: 37, y: 135, width: 650, size: 25, color: cyan, bold: true)
draw(copy.header[3], x: 37, y: 173, width: 650, size: 22, color: cyan, bold: true)

let frames: [(CGFloat, CGFloat)] = [(208,447),(454,695),(702,934),(940,1149),(1156,1308),(1316,1462),(1469,1617),(1624,1777),(1784,1949)]
for (index, card) in copy.cards.enumerated() {
  let (top, bottom) = frames[index]
  draw(card.label, x: 40, y: top+7, width: 300, size: 43, color: mint, bold: true)
  let contentTop = top+60, valueX: CGFloat = 99, valueWidth: CGFloat = 236
  func rowSize(_ row: Row, body: CGFloat) -> CGFloat { row.label == "보조" ? min(body,18) : body }
  func rowValue(_ row: Row, body: CGFloat) -> String {
    guard row.label == "보조" else { return row.value }
    let attrs = attributes(rowSize(row, body: body), white)
    var lines: [String] = [], line = ""
    for item in row.value.components(separatedBy: " · ") {
      let candidate = line.isEmpty ? item : line + " · " + item
      if !line.isEmpty && (candidate as NSString).size(withAttributes: attrs).width > valueWidth {
        lines.append(line); line = item
      } else { line = candidate }
    }
    if !line.isEmpty { lines.append(line) }
    return lines.joined(separator: "\n")
  }
  func contentHeight(_ body: CGFloat) -> CGFloat {
    card.rows.reduce(CGFloat(0)) { sum, row in
      sum + max(22, textHeight(rowValue(row, body: body), width: valueWidth, size: rowSize(row, body: body))) + 2
    }
  }
  var body: CGFloat = 20
  while contentTop + contentHeight(body) > bottom-8 && body > 17 { body -= 0.5 }
  guard contentTop + contentHeight(body) <= bottom-8 else { fatalError("Text overflows card \(index+1)") }
  var y = contentTop
  for row in card.rows {
    let size = rowSize(row, body: body)
    let value = rowValue(row, body: body)
    let rowHeight = max(22, textHeight(value, width: valueWidth, size: size))
    draw(row.label, x: 40, y: y, width: 49, size: size, height: rowHeight)
    draw(value, x: valueX, y: y, width: valueWidth, size: size, height: rowHeight)
    y += rowHeight + 2
  }
  print("Card \(index+1): \(card.label), body \(body)pt, text bottom \(y-2) / limit \(bottom-8)")
}

// Actual Korean font inside the three optional-garment badges.
for (x,y,w,h) in [(CGFloat(617),CGFloat(707),CGFloat(60),CGFloat(29)),(CGFloat(587),CGFloat(838),CGFloat(60),CGFloat(29)),(CGFloat(636),CGFloat(1018),CGFloat(60),CGFloat(29))] {
  let style = NSMutableParagraphStyle(); style.alignment = .center
  var attrs = attributes(18, white); attrs[.paragraphStyle] = style
  ("선택" as NSString).draw(in: CGRect(x: x, y: y+3, width: w, height: h-3), withAttributes: attrs)
}
for (index,line) in copy.footer.enumerated() {
  draw(line, x: 180, y: 1995+CGFloat(index)*42, width: 505, size: 22)
}
NSGraphicsContext.restoreGraphicsState()
guard let result = bitmap.makeImage(), let output = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("Cannot write guide image") }
CGImageDestinationAddImage(output, result, nil)
guard CGImageDestinationFinalize(output) else { fatalError("Cannot finish guide image") }
print("Saved \(result.width)x\(result.height) PNG to \(outputURL.path)")
