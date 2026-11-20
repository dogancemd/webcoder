const crypto = require('node:crypto');
const { DEFAULT_TEMPLATES } = require('./presets');

const MAX_STAGES = 20;

// Classic rooms use per-language `codes`; Monaco Workspace rooms also give each
// stage its own multi-file `workspace` ({ files, folders, entryFile }).
function createStage(title, promptMarkdown = '', codes = DEFAULT_TEMPLATES, workspace = null) {
  const stage = { id: crypto.randomUUID(), title, promptMarkdown, codes: { ...codes } };
  if (workspace) stage.workspace = workspace;
  return stage;
}

function syncActiveStage(room) {
  const stage = room.stages.find((item) => item.id === room.activeStageId);
  if (stage) {
    stage.promptMarkdown = room.promptMarkdown;
    stage.codes = room.codes;
    if (room.workspace) stage.workspace = room.workspace;
  }
}

function activateStage(room, stage) {
  room.activeStageId = stage.id;
  room.promptMarkdown = stage.promptMarkdown;
  room.codes = stage.codes;
  if (stage.workspace) room.workspace = stage.workspace;
}

function getStageState(room) {
  syncActiveStage(room);
  return { stages: room.stages, activeStageId: room.activeStageId };
}

module.exports = { MAX_STAGES, createStage, syncActiveStage, activateStage, getStageState };
