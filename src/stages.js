const crypto = require('node:crypto');
const { DEFAULT_TEMPLATES } = require('./presets');

const MAX_STAGES = 20;

function createStage(title, promptMarkdown = '', codes = DEFAULT_TEMPLATES) {
  return { id: crypto.randomUUID(), title, promptMarkdown, codes: { ...codes } };
}

function syncActiveStage(room) {
  const stage = room.stages.find((item) => item.id === room.activeStageId);
  if (stage) {
    stage.promptMarkdown = room.promptMarkdown;
    stage.codes = room.codes;
  }
}

function activateStage(room, stage) {
  room.activeStageId = stage.id;
  room.promptMarkdown = stage.promptMarkdown;
  room.codes = stage.codes;
}

function getStageState(room) {
  syncActiveStage(room);
  return { stages: room.stages, activeStageId: room.activeStageId };
}

module.exports = { MAX_STAGES, createStage, syncActiveStage, activateStage, getStageState };
