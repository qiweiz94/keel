import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isAbsolutePath, resolveMaybeRelative, canonicalizePath, foldCase,
  normalizeForMatch, pathsEqual, currentFlavor,
} from '../path-normalize.js'

/**
 * These exercise win32 semantics via an explicit `flavor: 'win32'`
 * argument (never `process.platform`), so every case here runs — and can
 * fail — on this macOS build machine exactly as it would on a real
 * windows-latest CI runner. See path-normalize.ts's header for why a
 * flavor parameter is used instead of mocking `process.platform`: Node's
 * `path.win32`/`path.posix` are both always available regardless of the
 * host OS, so dispatching on an explicit flavor is real cross-platform
 * logic, not a simulation of it.
 */

describe('isAbsolutePath', () => {
  it('posix: / is absolute, relative is not', () => {
    expect(isAbsolutePath('/a/b', 'posix')).toBe(true)
    expect(isAbsolutePath('a/b', 'posix')).toBe(false)
  })

  it('win32: drive-qualified path is absolute', () => {
    expect(isAbsolutePath('C:\\Users\\x\\.env', 'win32')).toBe(true)
    expect(isAbsolutePath('C:/Users/x/.env', 'win32')).toBe(true)
  })

  it('win32: UNC path is absolute', () => {
    expect(isAbsolutePath('\\\\server\\share\\.env', 'win32')).toBe(true)
  })

  it('win32: drive-RELATIVE path (no separator after the colon) is NOT absolute', () => {
    // This is the case a naive /^[A-Za-z]:/ regex gets wrong.
    expect(isAbsolutePath('C:foo\\bar', 'win32')).toBe(false)
  })

  it('win32: a bare rooted path with no drive letter (root-relative-to-current-drive) IS absolute per Node semantics', () => {
    expect(isAbsolutePath('\\Users\\x', 'win32')).toBe(true)
  })

  it('win32: a relative path is not absolute', () => {
    expect(isAbsolutePath('src\\index.ts', 'win32')).toBe(false)
    expect(isAbsolutePath('src/index.ts', 'win32')).toBe(false)
  })
})

describe('resolveMaybeRelative', () => {
  it('posix: absolute path passes through unchanged', () => {
    expect(resolveMaybeRelative('/a/b.env', '/cwd', 'posix')).toBe('/a/b.env')
  })

  it('posix: relative path resolves against cwd', () => {
    expect(resolveMaybeRelative('b.env', '/cwd', 'posix')).toBe('/cwd/b.env')
  })

  it('win32: drive-absolute path is NOT re-rooted under cwd (the bug this replaces: a leading-"/" check would treat this as relative)', () => {
    const result = resolveMaybeRelative('C:\\secrets\\.env', 'C:\\project', 'win32')
    expect(result).toBe('C:\\secrets\\.env')
  })

  it('win32: UNC path passes through unchanged', () => {
    const result = resolveMaybeRelative('\\\\server\\share\\.env', 'C:\\project', 'win32')
    expect(result).toBe('\\\\server\\share\\.env')
  })

  it('win32: relative path resolves against a windows cwd', () => {
    const result = resolveMaybeRelative('.env', 'C:\\project', 'win32')
    expect(result).toBe('C:\\project\\.env')
  })

  it('empty string passes through on both flavors', () => {
    expect(resolveMaybeRelative('', '/cwd', 'posix')).toBe('')
    expect(resolveMaybeRelative('', 'C:\\cwd', 'win32')).toBe('')
  })
})

describe('canonicalizePath', () => {
  it('win32: backslashes normalize to forward slashes', () => {
    expect(canonicalizePath('C:\\Users\\x\\.env', 'win32')).toBe('C:/Users/x/.env')
  })

  it('win32: UNC prefix is preserved as exactly two leading slashes, not collapsed to one', () => {
    expect(canonicalizePath('\\\\server\\share\\.env', 'win32')).toBe('//server/share/.env')
  })

  it('win32: a UNC path already mixing separators still normalizes to a clean double-slash root', () => {
    expect(canonicalizePath('\\\\server/share\\sub', 'win32')).toBe('//server/share/sub')
  })

  it('win32: drive letter is uppercased', () => {
    expect(canonicalizePath('c:\\users\\x', 'win32')).toBe('C:/users/x')
  })

  it('win32: a trailing slash is preserved (load-bearing for substring-style matchers — see the module header)', () => {
    expect(canonicalizePath('C:\\project\\', 'win32')).toBe('C:/project/')
    expect(canonicalizePath('C:\\', 'win32')).toBe('C:/')
  })

  it('posix: is idempotent / passthrough for an already-clean path', () => {
    expect(canonicalizePath('/repo/.env', 'posix')).toBe('/repo/.env')
  })

  it('posix: does not treat a leading // as UNC (posix flavor never has UNC)', () => {
    expect(canonicalizePath('//weird//path', 'posix')).toBe('/weird/path')
  })

  it('empty string passes through unchanged', () => {
    expect(canonicalizePath('', 'win32')).toBe('')
  })
})

describe('foldCase / normalizeForMatch', () => {
  it('win32 folds case (NTFS is case-insensitive)', () => {
    expect(foldCase('C:/Users/X/.ENV', 'win32')).toBe('c:/users/x/.env')
  })

  it('posix preserves case (POSIX filesystems are case-sensitive)', () => {
    expect(foldCase('/Users/X/.ENV', 'posix')).toBe('/Users/X/.ENV')
  })

  it('normalizeForMatch makes a real Windows argument path comparable to a "/"-authored YAML pattern', () => {
    const value = normalizeForMatch('C:\\Proj\\.KEEL\\rules.yaml', 'win32')
    const patternStyleValue = normalizeForMatch('C:/Proj/.keel/rules.yaml', 'win32')
    expect(value).toBe(patternStyleValue)
  })
})

describe('pathsEqual', () => {
  it('win32: same path, different case and separators, is equal', () => {
    expect(pathsEqual('C:\\Users\\x\\.env', 'c:/users/X/.ENV', 'win32')).toBe(true)
  })

  it('posix: same path different case is NOT equal', () => {
    expect(pathsEqual('/Users/x/.env', '/Users/X/.env', 'posix')).toBe(false)
  })

  it('win32: UNC paths compare equal regardless of separator style', () => {
    expect(pathsEqual('\\\\srv\\share\\f.txt', '//srv/share/f.txt', 'win32')).toBe(true)
  })

  it('different paths are not equal on either flavor', () => {
    expect(pathsEqual('/a/b', '/a/c', 'posix')).toBe(false)
    expect(pathsEqual('C:\\a\\b', 'C:\\a\\c', 'win32')).toBe(false)
  })
})

describe('currentFlavor (wiring proof only — everything above uses an explicit flavor)', () => {
  const originalPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('reads process.platform at call time, not at module load', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(currentFlavor()).toBe('win32')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(currentFlavor()).toBe('posix')
  })

  it('isAbsolutePath defaults to the live currentFlavor() when no flavor is passed', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    // Only a win32-absolute check would pass here (drive-qualified, no leading /).
    expect(isAbsolutePath('C:\\a\\b')).toBe(true)
  })
})
