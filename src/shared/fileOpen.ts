// Where a file named in the chat opens when its path is clicked. Pure, and shared: the renderer words the chip's
// tooltip and menu from it, and main decides from it again (never trusting the renderer) what a click may do.
//
// Things to look at (a page, a picture, a PDF, a film, an office file) open in the OS default app. Text and code open
// in the editor from Settings → Open in apps: the OS default for those is often wrong (on Windows `.ts` is a video),
// and for a script (`.bat`, `.ps1`, `.sh`, `.js` on Windows) it runs the script. An editor never runs what it opens.
// Programs, installers, bundles, shortcuts and archives are only shown in File Explorer or Finder. An agent can
// write any file, so nothing but the kinds in opensInDefaultApp ever reaches the OS's own open.

export type FileOpenKind = 'browser' | 'image' | 'pdf' | 'media' | 'document' | 'editor' | 'reveal'

const BY_EXTENSION: Record<string, FileOpenKind> = {}
const add = (kind: FileOpenKind, list: string) => {
  for (const ext of list.split(' ')) BY_EXTENSION[ext] = kind
}
add('browser', 'html htm xhtml')
add('image', 'png jpg jpeg gif webp bmp svg ico avif tif tiff heic')
add('pdf', 'pdf')
add('media', 'mp4 m4v mov webm mkv avi mp3 wav m4a flac ogg oga aac')
add('document', 'docx doc xlsx xls pptx ppt odt ods odp rtf csv pages numbers key')
add(
  'reveal',
  // Programs, installers, app bundles and shortcuts: the OS runs these on open, and an editor can't show them.
  'exe com scr pif cpl msi msp msix appx appxbundle appref-ms application gadget lnk scf msc jar ' +
    'app workflow pkg mpkg dmg appimage run ' +
    // Archives: opening one may unpack it where it is.
    'zip tar gz tgz bz2 xz 7z rar iso img'
)

function extension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Where a click on this path opens it. A name with no extension (Makefile, LICENSE) is text. */
export function fileOpenKind(path: string): FileOpenKind {
  return BY_EXTENSION[extension(path)] ?? 'editor'
}

/** The kinds a click hands to the OS default app (shell.openPath). */
export function opensInDefaultApp(kind: FileOpenKind): boolean {
  return kind !== 'editor' && kind !== 'reveal'
}

/** A full path on this computer: `C:\…`, `\\server\…` or `/…`. */
export function isAbsolutePath(path: string): boolean {
  return /^[a-z]:[\\/]|^\\\\|^\//i.test(path)
}
