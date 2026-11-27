import { expect, test } from "vitest";
import { GuiImages } from "../src/gui-images.ts";

test("extracts chunked Kitty images without returning their payload in history rows", () => {
  const bytes = Buffer.from("89504e470d0a1a0a00010203", "hex");
  const data = bytes.toString("base64");
  const lines = [`  \x1b_Ga=T,f=100,c=4,r=3,m=1;${data.slice(0, 8)}\x1b\\\x1b_Gm=0;${data.slice(8)}\x1b\\`, "", "", "after"];
  const images = new GuiImages();
  const page = images.page(lines, 1, 2);
  expect(page.lines).toEqual(["", ""]);
  expect(page.images).toHaveLength(1);
  expect(page.images[0]).toMatchObject({ row: 0, column: 2, rows: 3, columns: 4, mime: "image/png" });
  expect(images.chunk(page.images[0]!.id, 0, 1024)?.data).toBe(data);
});

test("extracts iTerm images anchored by their cursor-up sequence", () => {
  const bytes = Buffer.from("89504e470d0a1a0a00010203", "hex");
  const data = bytes.toString("base64");
  const images = new GuiImages();
  const page = images.page(["", "", `\x1b[2A\x1b]1337;File=inline=1;width=4;height=auto:${data}\x07`], 0, 3);
  expect(page.images[0]).toMatchObject({ row: 0, rows: 3, columns: 4, mime: "image/png" });
  expect(page.lines.join("")).not.toContain(data);
});
