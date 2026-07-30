function shouldBeginRendererGeneration(details) {
  return !!details
    && details.isMainFrame === true
    && details.isSameDocument !== true;
}

module.exports = {
  shouldBeginRendererGeneration,
};
