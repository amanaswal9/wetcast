"""Does NASA's satellite rain (imerg.py) help Wetcast's rain forecasts? A one-off check, kept to rerun.

    python -m weatherai_ml.imerg_check          # after imerg.py and rain_amount; about 30 minutes

Rule written before any fit (2026-11-23 12:28 UTC):
A. Satellite rain as an input to the rain correction, using only hours ending 14 h or more before the
   issue time (the Late Run's delay). Keep it if the 2025 out-of-fold R2 against Open-Meteo rises by at
   least 0.01 and the error in hours that rained does not get worse. A no-delay run shows the ceiling.
B. Score the forecasts on the 2026 test period against NASA rain, next to Open-Meteo's own day-old
   forecast. Report only.
Result: A not kept (R2 0.139 -> 0.136; even the no-delay ceiling 0.138). B: see ensemble/imerg_check.json.
Writes artifacts/india/ensemble/imerg_check.json; changes no model. Runs on import (a script, not a library).
"""

import glob
import json

import lightgbm as lgb
import numpy as np
import pandas as pd

from weatherai_ml.config import artifacts_dir
from weatherai_ml.dataset import load_dataset
from weatherai_ml.train import future_index
from weatherai_ml.rain_amount import design, PARAMS, FOLDS, STRIDE, RECENT_HOURS, P
from weatherai_ml.outlook import load_for_dataset
R='india'; root=artifacts_dir(R); out=root/'ensemble'; cache=root/'calibration'
team=json.loads((out/'ensemble.json').read_text())['members']
leads=json.loads((out/'rain_chance.json').read_text())['leads']
ds=load_dataset(R); months,hours=np.asarray(ds.times.month),np.asarray(ds.times.hour)
im_df=pd.concat(pd.read_parquet(f) for f in sorted(glob.glob('data/raw_india/imerg/*.parquet'))).set_index(['city','time'])['box_mm']
im=np.full(len(ds.times),np.nan)
for k,c in enumerate(ds.cities):
    rows=np.flatnonzero(ds.city_of_row==k)
    im[rows]=im_df.xs(c.id).reindex(ds.times[rows]).to_numpy()
print('imerg missing',np.isnan(im).mean())
def load(s):
    d=np.load(cache/f'ensemble__{s}.npz'); ends=d['ends']; preds=[]
    for m in team:
        md=np.load(cache/f'{m}__{s}.npz'); idx=np.searchsorted(md['ends'],ends); preds.append(md['pred'][idx].astype(float))
    return ends,np.stack(preds,-1)
def recent(ends): return np.stack([ds.targets[ends-k,P] for k in range(RECENT_HOURS-1,-1,-1)],-1)
def sat(ends,lag,H):
    last=im[ends-lag]; s6=sum(im[ends-lag-k] for k in range(6)); s24=sum(im[ends-lag-k] for k in range(24))
    f=np.stack([np.log1p(last),np.log1p(s6),np.log1p(s24)],-1)
    return np.repeat(f,H,0)
def X_of(ends,mem,lag=None):
    rain=np.clip(mem[:,:,P,:],0,None)
    X=design(rain.mean(-1),rain,months[ends],hours[ends],recent(ends),leads)
    return X if lag is None else np.hstack([X,sat(ends,lag,mem.shape[1]).astype(np.float32)])
ve,vm=load('val_train'); H=vm.shape[1]
vy=np.clip(ds.targets[future_index(ve)][...,P],0,None).ravel()
vmon=np.repeat(months[ve],H); keep=np.repeat(np.arange(len(ve))%STRIDE==0,H)
def score(p,y):
    wet=y>=0.1
    return dict(r2=round(1-((p-y)**2).sum()/((y-y.mean())**2).sum(),4), rmse=round(float(np.sqrt(((p-y)**2).mean())),4),
                wet_rmse=round(float(np.sqrt(((p-y)[wet]**2).mean())),4), mae=round(float(np.abs(p-y).mean()),4))
res={}; finals={}
for name,lag in [('base',None),('sat_lag14',14),('sat_nodelay_ceiling',0)]:
    X=X_of(ve,vm,lag)
    first=lgb.train(PARAMS,lgb.Dataset(X[keep&(vmon<=9)],vy[keep&(vmon<=9)]),3000,valid_sets=[lgb.Dataset(X[vmon>=10],vy[vmon>=10])],callbacks=[lgb.early_stopping(50,verbose=False)])
    trees=first.best_iteration; oof=np.zeros_like(vy)
    for fold in FOLDS:
        ins=np.isin(vmon,fold); oof[ins]=lgb.train(PARAMS,lgb.Dataset(X[keep&~ins],vy[keep&~ins]),trees).predict(X[ins])
    res[name]=dict(trees=trees,val_oof=score(np.clip(oof,0,None),vy)); print(name,res[name],flush=True)
    finals[name]=(lgb.train(PARAMS,lgb.Dataset(X[keep],vy[keep]),trees),lag)
# B: 2026 test scored against NASA rain and against Open-Meteo
te,tm=load('test_train'); fut=future_index(te)
y_om=np.clip(ds.targets[fut][...,P],0,None).ravel(); y_im=im[fut].ravel()
outlook=load_for_dataset(ds,R)[fut].ravel()
fc={'ours_corrected':np.clip(finals['base'][0].predict(X_of(te,tm)),0,None),
    'ours_with_sat_lag14':np.clip(finals['sat_lag14'][0].predict(X_of(te,tm,14)),0,None),
    'openmeteo_dayold_forecast':outlook,
    'members_plain_mean':np.clip(tm[:,:,P,:],0,None).mean(-1).ravel(),
    'persistence_last_hour':np.repeat(np.clip(ds.targets[te,P],0,None),H)}
ok=np.isfinite(y_im)&np.isfinite(outlook)
B={}
for k,p in fc.items():
    B[k]={'vs_openmeteo':score(p[ok],y_om[ok]),'vs_nasa':score(p[ok],y_im[ok]),'corr_nasa':round(float(np.corrcoef(p[ok],y_im[ok])[0,1]),4)}
    print(k,B[k],flush=True)
B['openmeteo_archive_itself']={'vs_nasa':score(y_om[ok],y_im[ok]),'corr_nasa':round(float(np.corrcoef(y_om[ok],y_im[ok])[0,1]),4)}
print('archive',B['openmeteo_archive_itself'])
(out/'imerg_check.json').write_text(json.dumps({'rule_written':'2026-11-23 12:28 UTC','A_validation_2025':res,'B_test_2026':B,'rows_test':int(ok.sum())},indent=1,default=float))
print('EXPERIMENT DONE')
