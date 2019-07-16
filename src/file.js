const path = require('path');
const os = require('os');
const url = require('url');
const fs = require('fs-extra');
const findUp = require('find-up');
const globby = require('globby');
const isGlob = require('is-glob');
const postcss = require('postcss');
const postcssUrl = require('postcss-url');
const Vinyl = require('vinyl');
const oust = require('oust');
const got = require('got');
const chalk = require('chalk');
const parseCssUrls = require('css-url-parser');
const tempy = require('tempy');
const slash = require('slash');
const debug = require('debug')('critical:file');
const {mapAsync, filterAsync, reduceAsync, forEachAsync} = require('./array');
const {FileNotFoundError} = require('./errors');

const BASE_WARNING = `${chalk.yellow('Warning:')} Missing base path. Consider 'base' option. https://goo.gl/PwvFVb`;

const warn = text => process.stderr.write(chalk.yellow(`${text}${os.EOL}`));

/**
 * Fixup slashes in file paths for Windows and remove volume definition in front
 * @param {string} str Path
 * @returns {string} Normalized path
 */
function normalizePath(str) {
  return process.platform === 'win32' ? slash(str.replace(/^[a-zA-Z]:/, '')) : str;
}

/**
 * Check whether a resource is external or not
 * @param {string} href Path
 * @returns {boolean} True if the path is remote
 */
function isRemote(href) {
  return /(^\/\/)|(:\/\/)/.test(href) && !href.startsWith('file:');
}

/**
 * Parse Url
 * @param {string} str The URL
 * @returns {URL|object} return new URL Object
 */
function urlParse(str = '') {
  if (/^\w+:\/\//.test(str)) {
    return new url.URL(str);
  }

  if (/^\/\//.test(str)) {
    return new url.URL(str, 'https://ba.se');
  }

  return {pathname: str};
}

/**
 * Get file uri considering OS
 * @param {string} file Absolute filepath
 * @returns {string} file uri
 */
function getFileUri(file) {
  if (!path.isAbsolute) {
    throw new Error('Path must be absolute to compute file uri');
  }

  const fileUrl = process.platform === 'win32' ? new url.URL(`file:///${file}`) : new url.URL(`file://${file}`);

  return fileUrl.href;
}

/**
 * Resolve Url
 * @param {string} from Resolve from
 * @param {string} to Resolve to
 * @returns {string} The resolved url
 */
function urlResolve(from = '', to = '') {
  if (isRemote(from)) {
    const {href: base} = urlParse(from);
    const {href} = new url.URL(to, base);
    return href;
  }

  if (path.isAbsolute(to)) {
    return to;
  }

  return path.join(from.replace(/[^/]+$/, ''), to);
}

/**
 * Check whether a resource is relative or not
 * @param {string} href Path
 * @returns {boolean} True if the path is relative
 */
function isRelative(href) {
  return !isRemote(href) && !path.isAbsolute(href);
}

/**
 * Wrapper for File.isVinyl to detect vinyl objects generated by gulp (vinyl < v0.5.6)
 * @param {*} file Object to check
 * @returns {boolean} True if it's a valid vinyl object
 */
function isVinyl(file) {
  return (
    Vinyl.isVinyl(file) ||
    file instanceof Vinyl ||
    (file && /function File\(/.test(file.constructor.toString()) && file.contents && file.path)
  );
}

/**
 * Check if a file exists (remote & local)
 * @param {string} href Path
 * @param {object} options Critical options
 * @returns {Promise<boolean>} Resolves to true if the file exists
 */
async function fileExists(href, options = {}) {
  if (isVinyl(href)) {
    return !href.isNull();
  }

  if (isRemote(href)) {
    const {request = {}} = options;
    request.method = request.method || 'head';
    try {
      const response = await fetch(href, {...options, request});
      const {statusCode} = response;

      if (request.method === 'head') {
        return parseInt(statusCode, 10) < 400;
      }

      return Boolean(response);
    } catch (error) {
      return false;
    }
  }

  return fs.existsSync(href) || fs.existsSync(href.replace(/\?.*$/, ''));
}

/**
 * Remove temporary files
 * @param {array} files Array of temp files
 * @returns {Promise<void>|*} Promise resolves when all files removed
 */
const getCleanup = files => () =>
  forEachAsync(files, file => {
    try {
      fs.remove(file);
    } catch (error) {
      debug(`${file} was already deleted`);
    }
  });

/**
 * Path join considering urls
 * @param {string} base Base path part
 * @param {string} part Path part to append
 * @returns {string} Joined path/url
 */
function joinPath(base, part) {
  if (!part) {
    return base;
  }

  if (isRemote(base)) {
    return urlResolve(base, part);
  }

  return path.join(base, part.replace(/\?.*$/, ''));
}

/**
 * Resolve path
 * @param {string} href Path
 * @param {[string]} search Paths to search in
 * @param {object} options Critical options
 * @returns {Promise<string>} Resolves to found path, rejects with FileNotFoundError otherwise
 */
async function resolve(href, search = [], options = {}) {
  let exists = await fileExists(href, options);
  if (exists) {
    return href;
  }

  for (const ref of search) {
    const checkPath = joinPath(ref, href);
    exists = await fileExists(checkPath, options); /* eslint-disable-line no-await-in-loop */
    if (exists) {
      return checkPath;
    }
  }

  throw new FileNotFoundError(href, search);
}

/**
 * Glob pattern
 * @param {array|string} pattern Glob pattern
 * @param {string} base Critical base option
 * @returns {Promise<[string]>} Found files
 */
function glob(pattern, {base} = {}) {
  // Evaluate globs based on base path
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  // Prepend base if it's not empty & not remote
  const prependBase = pattern => (base && !isRemote(base) ? [path.join(base, pattern)] : []);

  return reduceAsync(
    patterns,
    async (files, pattern) => {
      if (isGlob(pattern)) {
        const result = await globby([...prependBase(pattern), pattern]);
        return [...files, ...result];
      }

      return [...files, pattern];
    },
    []
  );
}

/**
 * Rebase image url in css
 *
 * @param {Buffer|string} css Stylesheet
 * @param {string} from Rebase from url
 * @param {string} to Rebase to url
 * @param {string|function} method Rebase method. See https://github.com/postcss/postcss-url#options-combinations
 * @returns {Buffer} Rebased css
 */
function rebaseAssets(css, from, to, method = 'rebase') {
  let rebased = css.toString();

  debug('Rebase assets', {from, to});

  if (/\/$/.test(to)) {
    to += 'temp.html';
  }

  if (/\/$/.test(from)) {
    from += 'temp.css';
  }

  if (isRemote(from)) {
    const {pathname} = urlParse(from);
    from = pathname;
  }

  if (typeof method === 'function') {
    const transform = (asset, ...rest) => {
      const assetNormalized = {
        ...asset,
        absolutePath: normalizePath(asset.absolutePath),
        relativePath: normalizePath(asset.relativePath),
      };

      return method(assetNormalized, ...rest);
    };

    rebased = postcss()
      .use(postcssUrl({url: transform}))
      .process(css, {from, to}).css;
  } else if (from && to) {
    rebased = postcss()
      .use(postcssUrl({url: method}))
      .process(css, {from, to}).css;
  }

  return Buffer.from(rebased);
}

/**
 * Token generated by concatenating username and password with `:` character within a base64 encoded string.
 * @param  {String} user User identifier.
 * @param  {String} pass Password.
 * @returns {String} Base64 encoded authentication token.
 */
const token = (user, pass) => Buffer.from([user, pass].join(':')).toString('base64');

/**
 * Get external resource. Try https and falls back to http
 * @param {string} uri Source uri
 * @param {object} options Options passed to critical
 * @param {boolean} secure Use https?
 * @returns {Promise<Buffer|response>} Resolves to fetched content or response object for HEAD request
 */
async function fetch(uri, options = {}, secure = true) {
  const {user, pass, userAgent, request = {}} = options;
  const {headers = {}, method = 'get'} = request;
  let resourceUrl = uri;
  let protocolRelative = false;

  // Consider protocol-relative urls
  if (/^\/\//.test(uri)) {
    protocolRelative = true;
    resourceUrl = urlResolve(`http${secure ? 's' : ''}://te.st`, uri);
  }

  request.rejectUnauthorized = false;
  if (user && pass) {
    headers.Authorization = 'Basic ' + token(user, pass);
  }

  if (userAgent) {
    headers['User-Agent'] = userAgent;
  }

  debug(`Fetching resource: ${resourceUrl}`, {...request, headers});

  try {
    const response = await got(resourceUrl, {...request, headers});
    if (method === 'head') {
      return response;
    }

    return Buffer.from(response.body || '');
  } catch (error) {
    // Try again with http
    if (secure && protocolRelative) {
      debug(`${error.message} - trying again over http`);
      return fetch(uri, options, false);
    }

    debug(`${resourceUrl} failed: ${error.message}`);

    if (method === 'head') {
      return error.response;
    }

    if (error.response) {
      return Buffer.from(error.response.body || '');
    }

    throw error;
  }
}

/**
 * Extract stykesheet urls from html document
 * @param {Vinyl} file Vinyl file object (document)
 * @returns {[string]} Stylesheet urls from document source
 */
function getStylesheetHrefs(file) {
  if (!isVinyl(file)) {
    throw new Error('Parameter file needs to be a vinyl object');
  }

  const stylesheets = oust.raw(file.contents.toString(), 'stylesheets');
  const preloads = oust.raw(file.contents.toString(), 'preload');

  return [...stylesheets, ...preloads]
    .filter(link => link.$el.attr('media') !== 'print' && Boolean(link.value))
    .map(link => link.value);
}

/**
 * Extract asset urls from stylesheet
 * @param {Vinyl} file Vinyl file object (stylesheet)
 * @returns {[string]} Asset urls from stykesheet source
 */
function getAssets(file) {
  if (!isVinyl(file)) {
    throw new Error('Parameter file needs to be a vinyl object');
  }

  return parseCssUrls(file.contents.toString());
}

/**
 * Compute Path to Html document based on docroot
 * @param {Vinyl} file The file we want to check
 * @param {object} options Critical options object
 * @returns {Promise<string>} Computed path
 */
async function getDocumentPath(file, options = {}) {
  let {base} = options;

  // Check remote
  if (file.remote) {
    let {pathname} = file.urlObj;
    if (/\/$/.test(pathname)) {
      pathname += 'index.html';
    }

    return pathname;
  }

  // If we don't have a file path and
  if (!file.path) {
    return '';
  }

  if (base) {
    base = path.resolve(base);
    return normalizePath(`/${path.relative(base, file.path || base)}`);
  }

  // Check local and assume base path based on relative stylesheets
  if (file.stylesheets) {
    const relativeRefs = file.stylesheets.filter(href => isRelative(href));
    const absoluteRefs = file.stylesheets.filter(href => path.isAbsolute(href));
    // If we have no stylesheets inside, fall back to path relative to process cwd
    if (relativeRefs.length === 0 && absoluteRefs.length === 0) {
      process.stderr.write(BASE_WARNING);

      return normalizePath(`/${path.relative(process.cwd(), file.path)}`);
    }

    // Compute base path based on absolute links
    if (relativeRefs.length === 0) {
      const [ref] = absoluteRefs;
      const paths = await getAssetPaths(file, ref, options);
      try {
        const filepath = await resolve(ref, paths, options);
        return normalizePath(`/${path.relative(normalizePath(filepath).replace(ref, ''), file.path)}`);
      } catch (error) {
        process.stderr.write(BASE_WARNING);

        return normalizePath(`/${path.relative(process.cwd(), file.path)}`);
      }
    }

    // Compute path based on relative stylesheet links
    const dots = relativeRefs.reduce((res, href) => {
      const match = /^(\.\.\/)+/.exec(href);

      return match && match[0].length > res.length ? match[0] : res;
    }, './');

    const tmpBase = path.resolve(path.dirname(file.path), dots);

    return normalizePath(`/${path.relative(tmpBase, file.path)}`);
  }

  return '';
}

/**
 * Get path for remote stylesheet. Compares document host with stylesheet host
 * @param {object} fileObj Result of urlParse(style url)
 * @param {object} documentObj Result of urlParse(document url)
 * @param {string} filename Filename
 * @returns {string} Path to css (can be remote or local relative to document base)
 */
function getRemoteStylesheetPath(fileObj, documentObj, filename) {
  let {hostname: styleHost, port: stylePort, pathname} = fileObj;
  const {hostname: docHost, port: docPort} = documentObj || {};

  if (filename) {
    pathname = joinPath(path.dirname(pathname), path.basename(filename));
    fileObj.pathname = normalizePath(pathname);
  }

  if (`${styleHost}:${stylePort}` === `${docHost}:${docPort}`) {
    return pathname;
  }

  return url.format(fileObj);
}

/**
 * Get path to stylesheet based on docroot
 * @param {Vinyl} document Optional reference document
 * @param {Vinyl} file the file we want to check
 * @param {object} options Critical options object
 * @returns {Promise<string>} Computed path
 */
function getStylesheetPath(document, file, options = {}) {
  let {base} = options;

  // Check remote
  if (file.remote) {
    return getRemoteStylesheetPath(file.urlObj, document.urlObj);
  }

  // Generate path relative to document if stylesheet is referenced relative
  //
  if (isRelative(file.path) && document.virtualPath) {
    return normalizePath(joinPath(path.dirname(document.virtualPath), file.path));
  }

  if (base && path.resolve(file.path).includes(path.resolve(base))) {
    base = path.resolve(base);
    return normalizePath(`/${path.relative(path.resolve(base), path.resolve(file.path))}`);
  }

  // Try to compute path based on document link tags with same name
  const stylesheet = document.stylesheets.find(href => {
    const {pathname} = urlParse(href);
    const name = path.basename(pathname);
    return name === path.basename(file.path);
  });

  if (stylesheet && isRelative(stylesheet) && document.virtualPath) {
    return normalizePath(joinPath(path.dirname(document.virtualPath), stylesheet));
  }

  if (stylesheet && isRemote(stylesheet)) {
    return getRemoteStylesheetPath(urlParse(stylesheet), document.urlObj);
  }

  if (stylesheet) {
    return stylesheet;
  }

  // Try to find stylesheet path based on document link tags
  const [unsafestylesheet] = document.stylesheets.sort(a => (isRemote(a) ? 1 : -1));
  if (unsafestylesheet && isRelative(unsafestylesheet) && document.virtualPath) {
    return normalizePath(
      joinPath(path.dirname(document.virtualPath), joinPath(path.dirname(unsafestylesheet), path.basename(file.path)))
    );
  }

  if (unsafestylesheet && isRemote(unsafestylesheet)) {
    return getRemoteStylesheetPath(urlParse(unsafestylesheet), document.urlObj, path.basename(file.path));
  }

  if (stylesheet) {
    return stylesheet;
  }

  process.stderr.write(BASE_WARNING);
  if (document.virtualPath && file.path) {
    return normalizePath(joinPath(path.dirname(document.virtualPath), path.basename(file.path)));
  }

  return '';
}

/**
 * Get a list of possible asset paths
 * Guess this is rather expensive so this method should only be used if
 * there's no other possible way
 *
 * @param {Vinyl} document Html document
 * @param {string} file File path
 * @param {object} options Critical options
 * @param {boolean} strict Check for file existance
 * @returns {Promise<[string]>} List of asset paths
 */
async function getAssetPaths(document, file, options = {}, strict = true) {
  const {base, rebase = {}, assetPaths = []} = options;
  const {history = [], url: docurl = '', urlObj} = document;
  const {from, to} = rebase;
  const {pathname: urlPath} = urlObj || {};
  const [docpath] = history;

  if (isVinyl(file)) {
    return [];
  }

  // Remove double dots in the middle
  const normalized = path.join(file);
  // Count directory hops
  const hops = normalized.split(path.sep).reduce((cnt, part) => (part === '..' ? cnt + 1 : cnt), 0);
  // Also findup first real dir path
  const [first] = normalized.split(path.sep).filter(p => p && p !== '..');
  const mappedAssetPaths = base ? assetPaths.map(a => joinPath(base, a)) : [];

  // Make a list of possible paths
  const paths = [
    ...new Set([
      base,
      base && isRelative(base) && path.join(process.cwd(), base),
      docurl,
      urlPath && urlResolve(urlObj.href, path.dirname(urlPath)),
      urlPath && !/\/$/.test(path.dirname(urlPath)) && urlResolve(urlObj.href, `${path.dirname(urlPath)}/`),
      docurl && urlResolve(docurl, file),
      docpath && path.dirname(docpath),
      ...assetPaths,
      ...mappedAssetPaths,
      to,
      from,
      base && docpath && path.join(base, path.dirname(docpath)),
      base && to && path.join(base, path.dirname(to)),
      base && from && path.join(base, path.dirname(from)),
      base && isRelative(file) && hops ? path.join(base, ...new Array(hops).fill('tmpdir'), file) : '',
      process.cwd(),
    ]),
  ];

  // Filter non existant paths
  const filtered = await filterAsync(paths, f => {
    if (!f) {
      return false;
    }

    return !strict || fileExists(f, options);
  });

  // Findup first directory in search path and add to the list if available
  const all = await reduceAsync(
    [...new Set(filtered)],
    async (result, cwd) => {
      if (isRemote(cwd)) {
        return [...result, cwd];
      }

      const up = await findUp(first, {cwd, type: 'directory'});
      if (up) {
        const upDir = path.dirname(up);

        if (hops) {
          // Add additional directories based on dirHops
          const additional = path
            .relative(upDir, cwd)
            .split(path.sep)
            .slice(0, hops);
          return [...result, upDir, path.join(upDir, ...additional)];
        }

        return [...result, upDir];
      }

      return result;
    },
    filtered
  );

  debug(`(getAssetPaths) Search file "${file}" in:`, [...new Set(all)]);

  // Return uniquq result
  return [...new Set(all)];
}

/**
 * Create vinyl object from filepath
 * @param {object} src File descriptor either pass "filepath" or "html"
 * @param {object} options Critical options
 * @returns {Promise<Vinyl>} The vinyl object
 */
async function vinylize(src, options = {}) {
  const {filepath, html} = src;
  const {rebase = {}} = options;
  const file = new Vinyl();
  file.cwd = '/';
  file.remote = false;

  if (html) {
    const {to} = rebase;
    file.contents = Buffer.from(html);
    file.path = to || '';
    file.virtualPath = to || '';
  } else if (filepath && isVinyl(filepath)) {
    return filepath;
  } else if (filepath && isRemote(filepath)) {
    file.remote = true;
    file.url = filepath;
    file.urlObj = urlParse(filepath);
    file.contents = await fetch(filepath, options);
    file.virtualPath = file.urlObj.pathname;
  } else if (filepath && fs.existsSync(filepath)) {
    file.path = filepath;
    file.virtualPath = filepath;
    file.contents = await fs.readFile(filepath);
  } else {
    throw new FileNotFoundError(filepath);
  }

  return file;
}

/**
 * Get stylesheet file object
 * @param {Vinyl} document Document vinyl object
 * @param {string} filepath Path/Url to css file
 * @param {object} options Critical options
 * @returns {Promise<Vinyl>} Vinyl representation fo the stylesheet
 */
async function getStylesheet(document, filepath, options = {}) {
  const {rebase = {}, css, strict} = options;
  const originalPath = filepath;
  const exists = await fileExists(filepath, options);

  if (!exists) {
    const searchPaths = await getAssetPaths(document, filepath, options);
    try {
      filepath = await resolve(filepath, searchPaths, options);
    } catch (error) {
      if (!isRemote(filepath) || strict) {
        throw error;
      }

      return new Vinyl();
    }
  }

  // Create absolute file paths for local files passed via css option
  // to prevent document relative stylesheet paths if they are not relative specified
  if (!isVinyl(filepath) && !isRemote(filepath) && css) {
    filepath = path.resolve(filepath);
  }

  const file = await vinylize({filepath}, options);

  // Restore original path for local files referenced from document and not from options
  if (!isRemote(originalPath) && !css) {
    file.path = originalPath;
  }

  // Get stylesheet path. Keeps stylesheet url if it differs from document url
  const stylepath = await getStylesheetPath(document, file, options);
  debug('(getStylesheet) Virtual Stylesheet Path:', stylepath);
  // We can safely rebase assets if we have:
  // - an url to the stylesheet
  // - if rebase.from and rebase.to is specified
  // - a valid document path and a stylesheet path
  // - an absolute positioned stylesheet so we can make the images absolute
  // - and rebase is not disabled (#359)
  // First respect the user input
  if (rebase === false) {
    return file;
  }

  if (rebase.from && rebase.to) {
    file.contents = rebaseAssets(file.contents, rebase.from, rebase.to);
  } else if (typeof rebase === 'function') {
    file.contents = rebaseAssets(file.contents, stylepath, document.virtualPath, rebase);
    // Next rebase to the stylesheet url
  } else if (isRemote(rebase.to || stylepath)) {
    const from = rebase.from || stylepath;
    const to = rebase.to || stylepath;
    const method = asset => (isRemote(asset.originUrl) ? asset.originUrl : urlResolve(to, asset.relativePath));
    file.contents = rebaseAssets(file.contents, from, to, method);

    // Use relative path to document (local)
  } else if (document.virtualPath) {
    file.contents = rebaseAssets(file.contents, rebase.from || stylepath, rebase.to || document.virtualPath);
  } else if (document.remote) {
    const {pathname} = document.urlObj;
    file.contents = rebaseAssets(file.contents, rebase.from || stylepath, rebase.to || pathname);

    // Make images absolute if we have an absolute positioned stylesheet
  } else if (path.isAbsolute(stylepath)) {
    file.contents = rebaseAssets(file.contents, rebase.from || stylepath, rebase.to || '/index.html', asset =>
      normalizePath(asset.absolutePath)
    );
  } else {
    warn(`Not rebasing assets for ${originalPath}. Use "rebase" option`);
  }

  debug('(getStylesheet) Result:', file);

  return file;
}

/**
 * Get css for document
 * @param {Vinyl} document Vinyl representation of HTML document
 * @param {object} options Critical options
 * @returns {Promise<string>} Css string unoptimized, Multiple stylesheets are concatenated with EOL
 */
async function getCss(document, options = {}) {
  const {css} = options;
  let stylesheets = [];

  if (css) {
    const files = await glob(css, options);
    stylesheets = await mapAsync(files, file => getStylesheet(document, file, options));
    debug('(getCss) css option set', files, stylesheets);
  } else {
    stylesheets = await mapAsync(document.stylesheets, file => getStylesheet(document, file, options));
    debug('(getCss) extract from document', document.stylesheets, stylesheets);
  }

  return stylesheets
    .filter(stylesheet => !stylesheet.isNull())
    .map(stylesheet => stylesheet.contents.toString())
    .join(os.EOL);
}

/**
 * We need to make sure the html file is available alongside the relative css files
 * as they are required by penthouse/puppeteer to render the html correctly
 * @see https://github.com/pocketjoso/penthouse/issues/280
 *
 * @param {Vinyl} document Vinyl representation of HTML document
 * @returns {Promise<string>} File url to html file for use in penthouse
 */
async function preparePenthouseData(document) {
  const tmp = [];
  const stylesheets = document.stylesheets || [];
  const [stylesheet, ...canBeEmpty] = stylesheets
    .filter(file => isRelative(file))
    .map(file => file.replace(/\?.*$/, ''));

  // Make sure we go as deep inside the temp folder as required by relative stylesheet hrefs
  const subfolders = [stylesheet, ...canBeEmpty]
    .reduce((res, href) => {
      const match = /^(\.\.\/)+/.exec(href || '');
      return match && match[0].length > res.length ? match[0] : res;
    }, './')
    .replace(/\.\.\//g, 'sub/');
  const dir = path.join(tempy.directory(), subfolders);
  const filename = path.basename(tempy.file({extension: 'html'}));
  const file = path.join(dir, filename);

  const htmlContent = document.contents.toString();
  // Inject all styles to make sure we have everything in place
  // because puppeteer doesn't seem to fetch protocol relative links
  // when served from file://
  const injected = htmlContent.replace(/(<head(?:\s[^>]*)?>)/gi, `$1<style>${document.css.toString()}</style>`);
  // Write html to temp file
  await fs.outputFile(file, injected);

  tmp.push(file);

  // Write styles to first stylesheet
  if (stylesheet) {
    const filename = path.join(dir, stylesheet);
    tmp.push(filename);
    await fs.outputFile(filename, document.css);
  }

  // Write empty string to rest of the linked stylesheets
  await forEachAsync(canBeEmpty, dummy => {
    const filename = path.join(dir, dummy);
    tmp.push(filename);
    fs.outputFile(filename, '');
  });

  return [getFileUri(file), getCleanup(tmp)];
}

/**
 * Get document file object
 * @param {string} filepath Path/Url to html file
 * @param {object} options Critical options
 * @returns {Promise<Vinyl>} Vinyl representation of HTML document
 */
async function getDocument(filepath, options = {}) {
  const {rebase = {}, base} = options;

  if (!isVinyl(filepath) && !isRemote(filepath) && !fs.existsSync(filepath) && base) {
    filepath = joinPath(base, filepath);
  }

  const document = await vinylize({filepath}, options);

  document.stylesheets = await getStylesheetHrefs(document);
  document.virtualPath = rebase.to || (await getDocumentPath(document, options));

  document.cwd = base || process.cwd();
  if (!base && document.path) {
    document.cwd = document.path.replace(document.virtualPath, '');
  }

  debug('(getDocument) Result: ', {
    path: document.path,
    url: document.url,
    remote: Boolean(document.remote),
    virtualPath: document.virtualPath,
    stylesheets: document.stylesheets,
    cwd: document.cwd,
  });

  document.css = await getCss(document, options);

  const [url, cleanup] = await preparePenthouseData(document);
  document.url = url;
  document.cleanup = cleanup;

  return document;
}

/**
 * Get document file object from raw html source
 * @param {string} html HTML source
 * @param {object} options Critical options
 * @returns {Promise<*>} Vinyl representation of HTML document
 */
async function getDocumentFromSource(html, options = {}) {
  const {rebase = {}, base} = options;
  const document = await vinylize({html}, options);

  document.stylesheets = await getStylesheetHrefs(document);
  document.virtualPath = rebase.to || (await getDocumentPath(document, options));
  document.cwd = base || process.cwd();

  debug('(getDocumentFromSource) Result: ', {
    path: document.path,
    url: document.url,
    remote: Boolean(document.remote),
    virtualPath: document.virtualPath,
    stylesheets: document.stylesheets,
    cwd: document.cwd,
  });

  document.css = await getCss(document, options);

  const [url, cleanup] = await preparePenthouseData(document);
  document.url = url;
  document.cleanup = cleanup;

  return document;
}

module.exports = {
  BASE_WARNING,
  normalizePath,
  isRemote,
  token,
  fileExists,
  resolve,
  urlParse,
  urlResolve,
  joinPath,
  vinylize,
  getStylesheetHrefs,
  getAssets,
  getAssetPaths,
  getDocumentPath,
  getStylesheetPath,
  getStylesheet,
  getDocument,
  getDocumentFromSource,
};
