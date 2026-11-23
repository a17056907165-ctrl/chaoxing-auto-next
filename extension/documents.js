/* Scrolls the content area inside an embedded course preview. */
(() => {
  "use strict";
  const { attachmentTask, httpUrl, idFor, visible } = globalThis.CxAutoNext;
  const documentPath = /\/ananas\/modules\/(?:zt\/)?(?:pdf|pptx?|document|docx?|word)(?:\/|$)|\/pdfjs\/(?:.*\/)?viewer\.html$/i;
  const documentFile = /\.(?:pdf|pptx?|docx?|wps)$/i;
  const attachmentSelector = 'iframe, object[type="application/pdf"], embed[type="application/pdf"]';
  const documentFrame = '.ans-insertdoc, .ans-insertpdf, .ans-insertppt, iframe[type="document"], iframe[type="pdf"], iframe[type="ppt"]';
  const viewerSelector = '#viewerContainer, #docContainer, #pdfContainer, #reader, #viewer, #img, .viewer-container, .pdf-container, .doc-reader';
  const revealed = new WeakMap();

  function isViewerUrl(url) {
    return documentPath.test(url.pathname) ||
      (url.hostname === 'pan-yz.chaoxing.com' && /^\/screen\/v2\//i.test(url.pathname));
  }

  function viewerDetails(doc) {
    const url = httpUrl(doc.URL, doc);
    return {
      documentViewer: Boolean(url && isViewerUrl(url)),
      hasInnerPreview: Boolean(doc.querySelector('iframe#panView'))
    };
  }

  function viewerUrl(element) {
    const attributes = element.tagName === 'OBJECT' ? ['data'] : ['src', 'data-src'];
    for (const attr of attributes) {
      const url = httpUrl(element.getAttribute(attr), element.ownerDocument);
      if (url && (isViewerUrl(url) || documentFile.test(url.pathname) || element.matches(documentFrame))) {
        url.hash = '';
        return url.href;
      }
    }
    return '';
  }

  function attachments(doc) {
    return [...doc.querySelectorAll(attachmentSelector)].flatMap(element => {
      const url = viewerUrl(element);
      if ((!url && !element.matches(documentFrame)) || !visible(element)) return [];
      const { required, completed } = attachmentTask(element);
      return required ? [{ element, id: idFor(element), url, completed }] : [];
    });
  }

  function inspect(doc) {
    return attachments(doc).map(({ id, url, completed }) => ({ id, url, completed }));
  }

  function reveal(doc, id) {
    const task = attachments(doc).find(item => item.id === id && !item.completed);
    if (!task) return;
    const { element, url } = task;
    const key = `${url}:${element.offsetHeight}`;
    if (revealed.get(element) === key) return;
    element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    revealed.set(element, key);
  }

  function scrollSurface(doc) {
    const view = doc.defaultView;
    const root = doc.scrollingElement;
    const hasOverflow = element => element.clientHeight > 0 && element.scrollHeight - element.clientHeight > 2;
    const largest = elements => elements.sort((left, right) =>
      right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight)[0];
    const isPreviewSized = element =>
      element.clientWidth >= view.innerWidth / 2 && element.clientHeight >= view.innerHeight / 3;
    const canScroll = element => element !== root && isPreviewSized(element) && hasOverflow(element) &&
      /^(?:auto|scroll|overlay)$/.test(view.getComputedStyle(element).overflowY) && visible(element);
    return largest([...doc.querySelectorAll(viewerSelector)].filter(canScroll)) ||
      largest([...doc.querySelectorAll('main, div, section, article')].filter(canScroll)) ||
      (root && hasOverflow(root) ? root : null);
  }

  function scrollToBottom(doc) {
    if (doc.readyState !== 'complete' || !doc.body) return;
    const surface = scrollSurface(doc);
    if (!surface) return;
    const bottom = surface.scrollHeight - surface.clientHeight;
    if (bottom - surface.scrollTop > 2) surface.scrollTo({ top: bottom, behavior: 'instant' });
  }

  globalThis.CxDocuments = { inspect, viewerDetails, reveal, scrollToBottom };
})();
