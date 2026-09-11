import { describe, expect, it } from "vitest"
import { createFileRouteHandler, fileUrl, FILE_ROUTE_PATH, publishedCount, publishFile } from "./file-server.js"

describe("file server", () => {
  it("publishes a file and serves it back with the right content type", () => {
    const handler = createFileRouteHandler()
    const name = publishFile(Buffer.from("png-bytes"), "image/png")

    expect(name.endsWith(".png")).toBe(true)
    const response = handler({
      params: { name },
      method: "GET",
      path: `${FILE_ROUTE_PATH}/${name}`
    } as never) as { headers: Record<string, string>; body: Buffer }

    expect(response.headers["content-type"]).toBe("image/png")
    expect(response.body.toString()).toBe("png-bytes")
  })

  it("returns 404 for unknown names", () => {
    const handler = createFileRouteHandler()
    const response = handler({ params: { name: "missing.png" } } as never) as { status: number }

    expect(response.status).toBe(404)
  })

  it("defaults unknown mime types to png", () => {
    const handler = createFileRouteHandler()
    const name = publishFile(Buffer.from([1, 2, 3]))

    expect(name.endsWith(".png")).toBe(true)
    const response = handler({ params: { name } } as never) as { headers: Record<string, string> }
    expect(response.headers["content-type"]).toBe("image/png")
  })

  it("composes public URLs from a base address", () => {
    expect(fileUrl("http://1.2.3.4:2536", "a.png"))
      .toBe("http://1.2.3.4:2536/plugin/adapter-qqbot/file/a.png")
    expect(fileUrl("https://tunnel.example.com/", "b.jpg"))
      .toBe("https://tunnel.example.com/plugin/adapter-qqbot/file/b.jpg")
  })

  it("caps the registry size", () => {
    for (let i = 0; i < 150; i++) publishFile(Buffer.from([i]), "image/png")
    expect(publishedCount()).toBeLessThanOrEqual(100)
  })
})
