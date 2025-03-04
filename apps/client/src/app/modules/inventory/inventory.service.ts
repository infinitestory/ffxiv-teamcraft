import { Injectable } from '@angular/core';
import { ofMessageType } from '../../core/rxjs/of-message-type';
import { debounceTime, distinctUntilChanged, filter, first, map, scan, shareReplay, startWith, switchMap, tap, withLatestFrom } from 'rxjs/operators';
import { BehaviorSubject, combineLatest, merge, Observable, of, Subject } from 'rxjs';
import { IpcService } from '../../core/electron/ipc.service';
import { ItemSearchResult } from '../../model/user/inventory/item-search-result';
import { ContainerType } from '../../model/user/inventory/container-type';
import { ItemOdr, OdrCoords } from './item-odr';
import { Retainer, RetainersService } from '../../core/electron/retainers.service';
import { AuthFacade } from '../../+state/auth.facade';
import { TranslateService } from '@ngx-translate/core';
import { UserInventory } from '../../model/user/inventory/user-inventory';
import { LodestoneIdEntry } from '../../model/user/lodestone-id-entry';
import { CharacterResponse } from '@xivapi/angular-client';
import { ContainerInfo, CurrencyCrystalInfo, InventoryModifyHandler, InventoryTransaction, ItemInfo, UpdateInventorySlot } from '@ffxiv-teamcraft/pcap-ffxiv';
import { NgSerializerService } from '@kaiu/ng-serializer';
import { InventoryItem } from '../../model/user/inventory/inventory-item';
import { InventoryPatch } from '../../model/user/inventory/inventory-patch';
import { InventoryEventType } from '../../model/user/inventory/inventory-event-type';
import { HttpClient } from '@angular/common/http';
import { Region } from '../settings/region.enum';
import { SettingsService } from '../settings/settings.service';
import { ContentIdLinkingPopupComponent } from './content-id-linking-popup/content-id-linking-popup.component';
import { NzModalService } from 'ng-zorro-antd/modal';
import { InventoryState } from './sync-state/inventory-state';

@Injectable({
  providedIn: 'root'
})
export class InventoryService {

  private retainerInformationsSync = {};

  private retainerInformations$ = this.ipc.retainerInformationPackets$.pipe(
    map(packet => {
      this.retainerInformationsSync[packet.retainerId.toString()] = packet;
      return Object.values<any>(this.retainerInformationsSync);
    })
  );

  private retainerSpawn$: Observable<string> = this.ipc.npcSpawnPackets$.pipe(
    withLatestFrom(this.retainerInformations$),
    filter(([npcSpawn, retainers]) => npcSpawn.name.length > 0 && retainers.some(retainer => retainer.name === npcSpawn.name)),
    map(([npcSpawn]) => {
      return npcSpawn.name;
    }),
    tap(name => this.ipc.log('Retainer spawn', name)),
    startWith('')
  );

  private characterEntries: Array<LodestoneIdEntry & { character: CharacterResponse }>;

  private odr$: BehaviorSubject<Record<string, ItemOdr>> = new BehaviorSubject<Record<string, ItemOdr>>({});

  private _inventoryPatches$ = new Subject<InventoryPatch>();

  public inventory$: Observable<UserInventory>;

  public inventoryPatches$ = this._inventoryPatches$.asObservable().pipe(
    shareReplay()
  );

  public readonly inventoryEvents$ = this.inventoryPatches$.pipe(
    filter(patch => !patch.moved),
    map(patch => {
      return {
        type: this.getEventType(patch),
        itemId: patch.itemId,
        amount: patch.quantity,
        containerId: patch.containerId,
        retainerName: patch.retainerName
      };
    })
  );

  private contentId$ = new Subject<{ type: 'SetContentId', contentId: string }>();

  private setInventory$ = new Subject<{ type: 'Set', inventory: UserInventory }>();

  private resetInventory$ = new Subject<{ type: 'Reset' }>();

  constructor(private ipc: IpcService, private authFacade: AuthFacade,
              private translate: TranslateService, private retainersService: RetainersService,
              private serializer: NgSerializerService, private http: HttpClient,
              private settings: SettingsService, private modal: NzModalService) {
    this.authFacade.characterEntries$.subscribe(entries => {
      this.characterEntries = entries;
    });
    this.ipc.on('dat:content-id', (event, contentId) => {
      this.setContentId(contentId);
    });
    this.ipc.on('dat:item-odr', (event, { odr, contentId }) => {
      this.odr$.next({ ...this.odr$.value, [contentId]: odr });
    });
    this.ipc.once('dat:all-odr:value', (event, odr) => {
      this.odr$.next(odr);
    });

    const itemInfoMessages$ = this.ipc.packets$.pipe(ofMessageType('itemInfo'));
    const containerInfoMessages$ = this.ipc.packets$.pipe(ofMessageType('containerInfo'));
    const currencyCrystalInfoMessages$ = this.ipc.packets$.pipe(ofMessageType('currencyCrystalInfo'));
    const inventoryModifyHandlerMessages$ = this.ipc.packets$.pipe(ofMessageType('inventoryModifyHandler'));
    const updateInventorySlotMessages$ = this.ipc.packets$.pipe(ofMessageType('updateInventorySlot'));

    const inventoryTransactionMessages$ = this.http.get<Record<'CN' | 'KR' | 'Global', Record<string, number>>>('https://cdn.jsdelivr.net/gh/karashiiro/FFXIVOpcodes@latest/constants.min.json').pipe(
      switchMap(constants => {
        const inventoryTransactionFlag = this.getInventoryTransactionFlag(constants);
        return this.ipc.packets$.pipe(
          ofMessageType('inventoryTransaction'),
          filter(message => {
            return message.parsedIpcData.type === inventoryTransactionFlag;
          })
        );
      })
    );

    const baseInventoryState$ = new Subject<UserInventory>();

    this.ipc.once('inventory:value', (e, inventory) => {
      const inventoryInstance = this.serializer.deserialize<UserInventory>(inventory, UserInventory);
      if (this.settings.clearInventoryOnStartup) {
        const reset = new UserInventory();
        reset.contentId = inventoryInstance.contentId;
        baseInventoryState$.next(reset);
      } else {
        baseInventoryState$.next(inventoryInstance);
      }
    });

    this.inventory$ = baseInventoryState$.pipe(
      switchMap(baseInventoryState => {
        const packetActions$ = merge(containerInfoMessages$, itemInfoMessages$, currencyCrystalInfoMessages$,
          inventoryModifyHandlerMessages$, updateInventorySlotMessages$, inventoryTransactionMessages$);

        const retainerActions$: Observable<{ type: 'RetainerSpawn', retainer: string }> = this.retainerSpawn$.pipe(
          map(retainer => ({ type: 'RetainerSpawn', retainer: retainer }))
        );

        const customActions$ = merge(this.contentId$, this.setInventory$, this.resetInventory$, retainerActions$);
        return merge(packetActions$, customActions$).pipe(
          scan((state: InventoryState, action) => {
            if (!action) {
              return state;
            }
            if (action.type !== 'SetContentId' && !state.inventory.contentId) {
              return state;
            }
            switch (action.type) {
              case 'SetContentId':
                state.inventory.contentId = action.contentId;
                return { ...state, inventory: state.inventory };
              case 'Reset':
                const reset = new UserInventory();
                reset.contentId = state.inventory.contentId;
                return { ...state, inventory: reset };
              case 'Set':
                return { ...state, inventory: action.inventory };
              case 'containerInfo':
                const itemInfos = state.itemInfoQueue.filter(itemInfo => itemInfo.containerSequence === action.parsedIpcData.sequence);
                const newQueue = state.itemInfoQueue.filter(itemInfo => itemInfo.containerSequence !== action.parsedIpcData.sequence);
                if (this.isRetainer(action.parsedIpcData.containerId)) {
                  return {
                    ...state,
                    itemInfoQueue: newQueue,
                    retainerInventoryQueue: [...state.retainerInventoryQueue, { containerInfo: action.parsedIpcData, itemInfos: itemInfos }]
                  };
                } else {
                  return {
                    ...state,
                    itemInfoQueue: newQueue,
                    inventory: this.handleContainerInfo(state.inventory, action.parsedIpcData, itemInfos)
                  };
                }
              case 'RetainerSpawn':
                let inventory = state.inventory.clone();
                state.retainerInventoryQueue.forEach(entry => {
                  inventory = this.handleContainerInfo(inventory, entry.containerInfo, entry.itemInfos, action.retainer);
                });
                return { ...state, retainer: action.retainer, retainerInventoryQueue: [], inventory };
              case 'inventoryModifyHandler':
                return { ...state, inventory: this.handleInventoryModifyHandler(state.inventory, action.parsedIpcData, state.retainer) };
              case 'updateInventorySlot':
              case 'inventoryTransaction':
                return { ...state, inventory: this.handleUpdateInventorySlot(state.inventory, action.parsedIpcData, state.retainer) };
              case 'itemInfo':
              case 'currencyCrystalInfo':
                return { ...state, itemInfoQueue: [...state.itemInfoQueue, action.parsedIpcData] };
              default:
                return { ...state };
            }
          }, { itemInfoQueue: [], retainerInventoryQueue: [], inventory: baseInventoryState, retainer: '' }),
          map(state => state.inventory),
          startWith(baseInventoryState)
        );
      }),
      debounceTime(1000),
      shareReplay(1)
    );
  }

  public init(): void {
    this.inventory$.subscribe(inventory => {
      this.ipc.send('inventory:set', inventory);
    });
    this.inventory$.pipe(
      map(inventory => inventory.contentId),
      distinctUntilChanged()
    ).subscribe(cid => {
      this.retainersService.contentId = cid;
    });
    this.ipc.send('inventory:get');
    this.ipc.send('dat:all-odr');
  }

  public getPosition(item: ItemSearchResult): Observable<number> {
    if (!item) {
      return of(-1);
    }
    return combineLatest([this.odr$, this.retainersService.retainers$]).pipe(
      map(([odr, retainers]) => {
        const itemOdr = odr[item.contentId];
        const inventory = this.getOdrInventory(item, itemOdr, retainers);
        let containerId = item.containerId;
        // Armory
        const armoryContainers = [
          ContainerType.ArmoryMain,
          ContainerType.ArmoryHead,
          ContainerType.ArmoryBody,
          ContainerType.ArmoryHand,
          ContainerType.ArmoryWaist,
          ContainerType.ArmoryLegs,
          ContainerType.ArmoryFeet,
          ContainerType.ArmoryOff,
          ContainerType.ArmoryEar,
          ContainerType.ArmoryNeck,
          ContainerType.ArmoryWrist,
          ContainerType.ArmoryRing,
          ContainerType.ArmorySoulCrystal
        ];
        if (armoryContainers.includes(item.containerId)) {
          containerId = 0;
        }
        // Saddlebag
        if ([ContainerType.SaddleBag0, ContainerType.SaddleBag1].includes(item.containerId)) {
          containerId -= ContainerType.SaddleBag0;
        }
        if ([ContainerType.PremiumSaddleBag0, ContainerType.PremiumSaddleBag1].includes(item.containerId)) {
          containerId -= ContainerType.PremiumSaddleBag0;
        }
        // Retainers
        const retainerContainers = [
          ContainerType.RetainerBag0,
          ContainerType.RetainerBag1,
          ContainerType.RetainerBag2,
          ContainerType.RetainerBag3,
          ContainerType.RetainerBag4,
          ContainerType.RetainerBag5,
          ContainerType.RetainerBag6
        ];
        if (retainerContainers.includes(item.containerId)) {
          containerId -= ContainerType.RetainerBag0;
        }
        return inventory.findIndex(coords => {
          return coords.slot === item.slot && coords.container === containerId;
        });
      })
    );
  }

  public getContainerTranslateKey(item: ItemSearchResult): string {
    if (item.retainerName && item.containerId !== ContainerType.RetainerMarket) {
      return item.retainerName;
    }
    return this.translate.instant(`INVENTORY.BAG.${this.getContainerName(item.containerId)}`);
  }

  public getContainerDisplayName(item: ItemSearchResult): string {
    const containerName = this.getContainerTranslateKey(item);
    if (item.isCurrentCharacter) {
      return containerName;
    } else {
      const entry = this.characterEntries.find(e => e.contentId === item.contentId);
      return `${containerName} (${entry?.character.Character.Name || this.translate.instant('COMMON.Unknown')})`;
    }
  }

  public getContainerName(containerId: number): string {
    switch (containerId) {
      case ContainerType.Bag0:
      case ContainerType.Bag1:
      case ContainerType.Bag2:
      case ContainerType.Bag3:
        return 'Bag';
      case ContainerType.RetainerBag0:
      case ContainerType.RetainerBag1:
      case ContainerType.RetainerBag2:
      case ContainerType.RetainerBag3:
      case ContainerType.RetainerBag4:
      case ContainerType.RetainerBag5:
      case ContainerType.RetainerBag6:
        return 'RetainerBag';
      case ContainerType.RetainerMarket:
        return 'RetainerMarket';
      case ContainerType.SaddleBag0:
      case ContainerType.SaddleBag1:
      case ContainerType.PremiumSaddleBag0:
      case ContainerType.PremiumSaddleBag1:
        return 'SaddleBag';
      case ContainerType.FreeCompanyBag0:
      case ContainerType.FreeCompanyBag1:
      case ContainerType.FreeCompanyBag2:
      case ContainerType.FreeCompanyBag3:
      case ContainerType.FreeCompanyBag4:
      case ContainerType.FreeCompanyBag5:
      case ContainerType.FreeCompanyBag6:
      case ContainerType.FreeCompanyBag7:
      case ContainerType.FreeCompanyBag8:
      case ContainerType.FreeCompanyBag9:
      case ContainerType.FreeCompanyBag10:
        return 'FC_chest';
      case ContainerType.ArmoryOff:
      case ContainerType.ArmoryHead:
      case ContainerType.ArmoryBody:
      case ContainerType.ArmoryHand:
      case ContainerType.ArmoryWaist:
      case ContainerType.ArmoryLegs:
      case ContainerType.ArmoryFeet:
      case ContainerType.ArmoryNeck:
      case ContainerType.ArmoryEar:
      case ContainerType.ArmoryWrist:
      case ContainerType.ArmoryRing:
      case ContainerType.ArmorySoulCrystal:
      case ContainerType.ArmoryMain:
        return 'Armory';
      case ContainerType.GearSet0:
        return 'Current_Gear';
    }
    return 'Other';
  }

  public setContentId(contentId: string | null): void {
    if (this.settings.ignoredContentIds.includes(contentId)) {
      return;
    }
    this.authFacade.user$.pipe(
      first(),
      withLatestFrom(this.inventory$),
      switchMap(([user, inventory]) => {
        if (contentId === null) {
          return of(null);
        }
        const isCustom = user.lodestoneIds.length === 0 && user.customCharacters.length > 0;
        if (isCustom) {
          const matchingCustomCharacter = user.customCharacters.find(entry => entry.contentId === contentId);
          if (matchingCustomCharacter) {
            return of(contentId);
          }
        } else {
          const matchingLodestoneEntry = user.lodestoneIds.find(entry => entry.contentId === contentId);
          if (matchingLodestoneEntry) {
            return of(contentId);
          }
        }
        console.log('New Content ID', contentId);
        // If we're here, there's no matching entries anywhere
        return this.modal.create({
          nzContent: ContentIdLinkingPopupComponent,
          nzComponentParams: {
            contentId: contentId,
            previousContentId: inventory.contentId
          },
          nzClosable: false,
          nzMaskClosable: false,
          nzFooter: null,
          nzTitle: this.translate.instant('INVENTORY.New_character_detected')
        }).afterClose.pipe(
          map((res) => {
            if (!res) {
              return 'ignored';
            }
            return contentId;
          })
        );
      }),
      first()
    ).subscribe(result => {
      this.contentId$.next({ type: 'SetContentId', contentId: result });
      this.authFacade.applyContentId(result);
    });
  }

  public setInventory(inventory: UserInventory): void {
    this.setInventory$.next({ type: 'Set', inventory: inventory });
  }

  public resetInventory(): void {
    this.resetInventory$.next({ type: 'Reset' });
  }

  private handleContainerInfo(inventory: UserInventory, packet: ContainerInfo, itemInfos: Array<ItemInfo | CurrencyCrystalInfo>, retainer?: string): UserInventory {
    const isRetainer = !!retainer;
    const containerKey = isRetainer ? `${retainer}:${packet.containerId}` : packet.containerId;
    if (containerKey === 2001) {
      inventory.lastZone = Date.now();
    }
    if (isRetainer && !retainer) {
      return inventory;
    }
    if (!inventory.items[inventory.contentId]) {
      inventory.items[inventory.contentId] = {};
    }
    inventory.items[inventory.contentId][containerKey] = {};

    itemInfos.forEach(itemInfo => {
      const item: InventoryItem = {
        itemId: +itemInfo.catalogId,
        containerId: +itemInfo.containerId,
        slot: +itemInfo.slot,
        quantity: +itemInfo.quantity,
        hq: (itemInfo as ItemInfo).hqFlag || false,
        spiritBond: +(itemInfo as ItemInfo).spiritBond || 0,
        materias: (itemInfo as ItemInfo).materia || []
      };
      if (isRetainer) {
        item.retainerName = retainer;
      }
      inventory.items[inventory.contentId][containerKey][itemInfo.slot] = item;
    });

    inventory.resetSearchCache();
    return inventory;
  }

  private handleInventoryModifyHandler(inventory: UserInventory, packet: InventoryModifyHandler, retainer: string): UserInventory {
    try {
      const patch = inventory.operateTransaction(packet, retainer);
      if (patch) {
        this._inventoryPatches$.next(patch);
      }
      return inventory;
    } catch (e) {
      console.log(packet);
      console.error(e);
      this.ipc.log(e.message, JSON.stringify(packet));
      return inventory;
    }
  }

  private handleUpdateInventorySlot(inventory: UserInventory, packet: UpdateInventorySlot | InventoryTransaction, retainer: string): UserInventory {
    try {
      const patch = inventory.updateInventorySlot(packet, retainer);
      if (patch) {
        this._inventoryPatches$.next(patch);
      }
      return inventory;
    } catch (e) {
      console.log(packet);
      console.error(e);
      this.ipc.log(e.message, JSON.stringify(packet));
      return inventory;
    }
  }

  private getOdrInventory(item: ItemSearchResult, odr: ItemOdr, retainers: Record<string, Retainer>): OdrCoords[] {
    if (!odr) {
      return [];
    }
    switch (item.containerId) {
      case ContainerType.Bag0:
      case ContainerType.Bag1:
      case ContainerType.Bag2:
      case ContainerType.Bag3:
        return odr.Player;
      case ContainerType.ArmoryMain:
        return odr.ArmoryMain;
      case ContainerType.ArmoryHead:
        return odr.ArmoryHead;
      case ContainerType.ArmoryBody:
        return odr.ArmoryBody;
      case ContainerType.ArmoryHand:
        return odr.ArmoryHand;
      case ContainerType.ArmoryWaist:
        return odr.ArmoryWaist;
      case ContainerType.ArmoryLegs:
        return odr.ArmoryLegs;
      case ContainerType.ArmoryFeet:
        return odr.ArmoryFeet;
      case ContainerType.ArmoryOff:
        return odr.ArmoryOff;
      case ContainerType.ArmoryEar:
        return odr.ArmoryEar;
      case ContainerType.ArmoryNeck:
        return odr.ArmoryNeck;
      case ContainerType.ArmoryWrist:
        return odr.ArmoryWrist;
      case ContainerType.ArmoryRing:
        return odr.ArmoryRing;
      case ContainerType.ArmorySoulCrystal:
        return odr.ArmorySoulCrystal;
      case ContainerType.SaddleBag0:
      case ContainerType.SaddleBag1:
        return odr.SaddleBag;
      case ContainerType.PremiumSaddleBag0:
      case ContainerType.PremiumSaddleBag1:
        return odr.PremiumSaddlebag;
      case ContainerType.RetainerBag0:
      case ContainerType.RetainerBag1:
      case ContainerType.RetainerBag4:
      case ContainerType.RetainerBag5:
      case ContainerType.RetainerBag6:
        const retainerKey = Object.keys(retainers).find(key => retainers[key].name.toLowerCase() === item.retainerName.toLowerCase());
        if (retainerKey) {
          const retainerEntry = odr.Retainers.find(retainer => retainer.id.endsWith(retainerKey));
          return retainerEntry?.inventory || [];
        }
        return [];
      default:
        return [];
    }
  }

  private isRetainer(containerId: number): boolean {
    return containerId >= 10000 && containerId < 20000;
  }

  private getEventType(patch: InventoryPatch): InventoryEventType {
    if (patch.quantity > 0) {
      return InventoryEventType.ADDED;
    } else if (patch.moved) {
      return InventoryEventType.MOVED;
    } else {
      return InventoryEventType.REMOVED;
    }
  }

  private getInventoryTransactionFlag(constants: Record<'CN' | 'KR' | 'Global', Record<string, number>>): number {
    switch (this.settings.region) {
      case Region.China:
        return constants.CN.InventoryOperationBaseValue - 1;
      case Region.Korea:
        return constants.KR.InventoryOperationBaseValue - 1;
      case Region.Global:
      default:
        return constants.Global.InventoryOperationBaseValue - 1;
    }
  }
}
