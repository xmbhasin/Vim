import * as _ from 'lodash';
import * as vscode from 'vscode';

import { CommandLine } from '../cmd_line/commandLine';
import { Configuration, IKeybinding } from '../configuration/configuration';
import { ModeName } from '../mode/mode';
import { ModeHandler } from '../mode/modeHandler';
import { AngleBracketNotation } from './../notation';
import { VimState } from './../state/vimState';

export class Remappers implements IRemapper {
  private remappers: IRemapper[];

  constructor() {
    this.remappers = [
      new InsertModeRemapper(true),
      new OtherModesRemapper(true),
      new InsertModeRemapper(false),
      new OtherModesRemapper(false),
    ];
  }

  get isPotentialRemap(): boolean {
    for (let remapper of this.remappers) {
      if (remapper.isPotentialRemap) {
        return true;
      }
    }
    return false;
  }

  public async sendKey(
    keys: string[],
    modeHandler: ModeHandler,
    vimState: VimState
  ): Promise<boolean> {
    let handled = false;
    for (let remapper of this.remappers) {
      handled = handled || (await remapper.sendKey(keys, modeHandler, vimState));
    }
    return handled;
  }
}

interface IRemapper {
  sendKey(keys: string[], modeHandler: ModeHandler, vimState: VimState): Promise<boolean>;
  readonly isPotentialRemap: boolean;
}

class Remapper implements IRemapper {
  private readonly _remappedModes: ModeName[];
  private readonly _recursive: boolean;
  private _remappings: IKeybinding[] = [];

  /**
   * Have the keys pressed so far potentially be a remap
   */
  private _isPotentialRemap = false;
  get isPotentialRemap(): boolean {
    return this._isPotentialRemap;
  }

  constructor(configKey: string, remappedModes: ModeName[], recursive: boolean) {
    this._recursive = recursive;
    this._remappedModes = remappedModes;

    const remappings = Configuration[configKey] as IKeybinding[];

    for (let remapping of remappings) {
      let before: string[] = [];
      if (remapping.before) {
        remapping.before.forEach(item => before.push(AngleBracketNotation.Normalize(item)));
      }

      let after: string[] = [];
      if (remapping.after) {
        remapping.after.forEach(item => after.push(AngleBracketNotation.Normalize(item)));
      }

      this._remappings.push(<IKeybinding>{
        before: before,
        after: after,
        commands: remapping.commands,
      });
    }
  }

  public async sendKey(
    keys: string[],
    modeHandler: ModeHandler,
    vimState: VimState
  ): Promise<boolean> {
    if (this._remappedModes.indexOf(vimState.currentMode) === -1) {
      return false;
    }

    const longestKeySequence = this._longestKeySequence();
    let remapping: IKeybinding | undefined;

    /**
     * Check to see if the keystrokes match any user-specified remapping.
     * In insert mode, we allow the users to precede the remapped command
     * with extraneous keystrokes (eg. "hello world jj").
     * In other modes, we have to precisely match the entire keysequence.
     */
    if (this._remappedModes.indexOf(ModeName.Insert) === -1) {
      remapping = _.find(this._remappings, map => {
        return map.before.join('') === keys.join('');
      });
    } else {
      for (let sliceLength = 1; sliceLength <= longestKeySequence; sliceLength++) {
        const slice = keys.slice(-sliceLength);
        const result = _.find(this._remappings, map => map.before.join('') === slice.join(''));

        if (result) {
          remapping = result;
          break;
        }
      }
    }

    if (remapping) {
      // Record length of remapped command
      vimState.recordedState.numberOfRemappedKeys += remapping.before.length;

      // If we remapped e.g. jj to esc, we have to revert the inserted "jj"
      if (this._remappedModes.indexOf(ModeName.Insert) >= 0) {
        // Revert every single inserted character. This is actually a bit of
        // a hack since we aren't guaranteed that each insertion inserted
        // only a single character.

        // We subtract 1 because we haven't actually applied the last key.
        await vimState.historyTracker.undoAndRemoveChanges(
          Math.max(0, (remapping.before.length - 1) * vimState.allCursors.length)
        );
      }

      if (!this._recursive) {
        vimState.isCurrentlyPerformingRemapping = true;
      }

      // We need to remove the keys that were remapped into different keys
      // from the state.
      const numToRemove = remapping.before.length - 1;
      vimState.recordedState.actionKeys = vimState.recordedState.actionKeys.slice(0, -numToRemove);
      vimState.keyHistory = vimState.keyHistory.slice(0, -numToRemove);

      if (remapping.after) {
        const count = vimState.recordedState.count || 1;
        vimState.recordedState.count = 0;

        for (let i = 0; i < count; i++) {
          await modeHandler.handleMultipleKeyEvents(remapping.after);
        }
      }

      if (remapping.commands) {
        for (const command of remapping.commands) {
          // Check if this is a vim command by looking for :
          if (command.command.slice(0, 1) === ':') {
            await CommandLine.Run(
              command.command.slice(1, command.command.length),
              modeHandler.vimState
            );
            await modeHandler.updateView(modeHandler.vimState);
          } else {
            await vscode.commands.executeCommand(command.command, command.args);
          }
        }
      }

      vimState.isCurrentlyPerformingRemapping = false;
      return true;
    }

    // Check to see if a remapping could potentially be applied when more keys are received
    this._isPotentialRemap = false;
    for (let remap of this._remappings) {
      if (keys.join('') === remap.before.slice(0, keys.length).join('')) {
        this._isPotentialRemap = true;
        break;
      }
    }
    return false;
  }

  private _longestKeySequence(): number {
    if (this._remappings.length > 0) {
      return _.maxBy(this._remappings, map => map.before.length).before.length;
    } else {
      return 1;
    }
  }
}

class InsertModeRemapper extends Remapper {
  constructor(recursive: boolean) {
    super(
      'insertModeKeyBindings' + (recursive ? '' : 'NonRecursive'),
      [ModeName.Insert],
      recursive
    );
  }
}

class OtherModesRemapper extends Remapper {
  constructor(recursive: boolean) {
    super(
      'otherModesKeyBindings' + (recursive ? '' : 'NonRecursive'),
      [ModeName.Normal, ModeName.Visual, ModeName.VisualLine, ModeName.VisualBlock],
      recursive
    );
  }
}
