import { createEnum } from 'ringcentral-integration/lib/Enum';
import { moduleActionTypes } from 'ringcentral-integration/enums/moduleActionTypes';

export default createEnum(
  [
    'updateMeetingSettings',
    'saveAsDefaultSetting',
    'initCreating',
    'created',
    'resetCreating', // for Office...TODO:
    'initUpdating',
    'updated',
    'resetUpdating',
  ],
  'RcVideo',
  moduleActionTypes,
);

export interface RcVideoActionTypes {
  updateMeetingSettings: string;
  saveAsDefaultSetting: string;
  initSuccess: string;
  initCreating: string;
  created: string;
  resetCreating: string;
  initUpdating: string;
  updated: string;
  resetUpdating: string;
}