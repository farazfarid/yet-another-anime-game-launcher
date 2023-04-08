import { join, basename } from "path-browserify";
import { Aria2 } from "../aria2";
import { CommonUpdateProgram } from "../common-update-ui";
import { Server } from "../constants";
import {
  mkdirp,
  humanFileSize,
  doStreamUnzip,
  removeFile,
  writeFile,
  hpatchz,
  forceMove,
  readAllLinesIfExists,
  removeFileIfExists,
} from "../utils";

async function* downloadAndPatch(updateFileZip: string, gameDir: string, aria2: Aria2): CommonUpdateProgram {
  const downloadTmp = join(gameDir, ".ariatmp");
  await mkdirp(downloadTmp);
  const updateFileTmp = join(downloadTmp, basename(updateFileZip));

  yield ["setUndeterminedProgress"];
  yield ["setStateText", "ALLOCATING_FILE"];
  let gameFileStart = false;
  for await (const progress of aria2.doStreamingDownload({
    uri: updateFileZip,
    absDst: updateFileTmp,
  })) {
    if (!gameFileStart && progress.downloadSpeed == BigInt(0)) {
      continue;
    }
    gameFileStart = true;
    yield [
      "setStateText",
      "DOWNLOADING_FILE_PROGRESS",
      basename(updateFileZip),
      humanFileSize(Number(progress.downloadSpeed)),
      humanFileSize(Number(progress.completedLength)),
      humanFileSize(Number(progress.totalLength)),
    ];
    yield [
      "setProgress",
      Number(
        (progress.completedLength * BigInt(10000)) / progress.totalLength
      ) / 100,
    ];
  }
  yield ["setStateText", "DECOMPRESS_FILE_PROGRESS"];
  for await (const [dec, total] of doStreamUnzip(updateFileTmp, gameDir)) {
    yield ["setProgress", (dec / total) * 100];
  }
  await removeFile(updateFileTmp);

  yield ['setStateText','PATCHING'];
  // delete files
  const deleteList = (
    await readAllLinesIfExists(join(gameDir, "deletefiles.txt"))
  ).filter((x) => x.trim() != "");

  const diffList: {
    remoteName: string;
  }[] = (await readAllLinesIfExists(join(gameDir, "hdifffiles.txt")))
    .filter((x) => x.trim() != "")
    .map((x) => JSON.parse(x));

  const patchCount = deleteList.length + diffList.length;
  let doneCount = 0;

  for (const file of deleteList) {
    await removeFile(join(gameDir, file));
    doneCount++;
    yield ['setProgress', doneCount / patchCount * 100];
  }
  await removeFileIfExists(join(gameDir, "deletefiles.txt"));
  // diff files

  for (const { remoteName: file } of diffList) {
    await hpatchz(
      join(gameDir, file),
      join(gameDir, file + ".hdiff"),
      join(gameDir, file + ".patched")
    );
    await forceMove(join(gameDir, file + ".patched"), join(gameDir, file));
    await removeFile(join(gameDir, file + ".hdiff"));
    doneCount++;
    yield ['setProgress', doneCount / patchCount * 100];
  }
  await removeFileIfExists(join(gameDir, "hdifffiles.txt"));
  yield ['setUndeterminedProgress'];
}

export async function* updateGameProgram({
  aria2,
  updateFileZip,
  gameDir,
  currentGameVersion,
  updatedGameVersion,
  server,
  updateVoicePackZips
}: {
  updateFileZip: string;
  gameDir: string;
  currentGameVersion: string;
  updatedGameVersion: string;
  aria2: Aria2;
  server: Server;
  updateVoicePackZips: string[];
}): CommonUpdateProgram {

  yield* downloadAndPatch(updateFileZip, gameDir, aria2);

  for(const updateVoicePackZip of updateVoicePackZips) {
    yield* downloadAndPatch(updateVoicePackZip, gameDir, aria2);
  }

  await writeFile(
    join(gameDir, "config.ini"),
    `[General]
game_version=${updatedGameVersion}
channel=${server.channel_id}
sub_channel=${server.subchannel_id}
cps=${server.cps}`
  );
}